import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { KeyObject } from 'node:crypto';
import { isWindows, logError, updatesDir } from './paths';
import { compareVersions, loadPublicKey, parseVersion, verifyFile } from './updateSignature';

/**
 * Keeps the app up to date from its GitHub releases. It looks for a newer `desktop-vX.Y.Z`
 * release, downloads the file for this platform in the background, and checks its signature
 * before it will run it (updateSignature.ts): only the release workflow holds the private key.
 * An update that doesn't verify is deleted, never run.
 *
 * - Windows: Purrlor-Setup.exe, run silently on restart or quit (/S /RELAUNCH).
 * - Linux AppImage: Purrlor-x86_64.AppImage, swapped in over the running file on restart or quit.
 * - Linux .deb (installed under /opt/Purrlor): purrlor_amd64.deb, installed with apt through
 *   pkexec, which asks for your password. So only on "Restart to update", never quietly on quit.
 * - Anything else (an unpacked build): only says a version is out.
 */
export type UpdateState = 'idle' | 'checking' | 'upToDate' | 'downloading' | 'ready' | 'failed';
export type UpdateStatus = {
  state: UpdateState;
  version: string | null;
  error: string | null;
  releaseUrl: string | null;
  /** False where this build can't install updates itself: it only says one exists. */
  automatic: boolean;
};

type Release = { version: string; url: string; file: string | null; signature: string | null };

const TAG_PREFIX = 'desktop-v';
const FIRST_CHECK_MS = 2 * 60_000;
const EVERY_MS = 6 * 60 * 60_000;

type InstallKind = 'windows' | 'appimage' | 'deb';

function installKind(): InstallKind | null {
  if (isWindows) return 'windows';
  if (process.platform !== 'linux') return null;
  if (process.env.APPIMAGE) return 'appimage';
  if (process.execPath.startsWith('/opt/Purrlor/') && existsSync('/var/lib/dpkg/info/purrlor.list')) return 'deb';
  return null;
}

const ASSETS: Record<InstallKind, string> = {
  windows: 'Purrlor-Setup.exe',
  appimage: 'Purrlor-x86_64.AppImage',
  deb: 'purrlor_amd64.deb',
};

function packageMetadata(): { repository: string | null; publicKey: string | null } {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { purrlor?: { updateRepository?: string; updatePublicKey?: string } };
    return { repository: pkg.purrlor?.updateRepository || null, publicKey: pkg.purrlor?.updatePublicKey || null };
  } catch {
    return { repository: null, publicKey: null };
  }
}

export class Updater {
  private readonly repository: string | null;
  private readonly key: KeyObject | null;
  private readonly kind = installKind();
  private readonly asset = this.kind && ASSETS[this.kind];
  private readonly current = parseVersion(app.getVersion()) ?? [0, 0, 0];
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readyFile: string | null = null;
  status: UpdateStatus;

  constructor(private readonly changed: (status: UpdateStatus) => void) {
    const meta = packageMetadata();
    this.repository = meta.repository;
    this.key = loadPublicKey(meta.publicKey);
    this.status = { state: 'idle', version: null, error: null, releaseUrl: null, automatic: this.canInstall };
  }

  get canInstall(): boolean {
    return this.key !== null && this.asset !== null && app.isPackaged;
  }

  /** Whether quitting (or signing in with an update waiting) may install it: not when it asks for a password. */
  get installsQuietly(): boolean {
    return this.canInstall && this.kind !== 'deb';
  }

  /** Checks in a couple of minutes and then every few hours, or stops checking. */
  schedule(automatic: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!automatic || !this.repository || !app.isPackaged) return;
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.check().finally(() => next(EVERY_MS));
      }, delay);
    };
    next(FIRST_CHECK_MS);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async check(): Promise<void> {
    if (this.busy || !this.repository || this.status.state === 'ready') return;
    this.busy = true;
    try {
      this.set({ state: 'checking', version: null, error: null, releaseUrl: null });
      const release = await this.findNewer();
      if (!release) {
        this.set({ state: 'upToDate', version: null, error: null, releaseUrl: null });
        return;
      }
      if (!this.canInstall || !release.file || !release.signature) {
        // Can't check it or can't install it here: say it's there and link to it.
        this.set({ state: 'failed', version: release.version, error: 'Download the new version from its release page.', releaseUrl: release.url });
        return;
      }
      this.set({ state: 'downloading', version: release.version, error: null, releaseUrl: release.url });
      this.readyFile = await this.download(release.version, release.file, release.signature);
      this.set({ state: 'ready', version: release.version, error: null, releaseUrl: release.url });
    } catch (err) {
      logError('update', err);
      const message = err instanceof UpdateRejected ? err.message : 'Couldn’t check for updates.';
      this.set({ state: 'failed', version: this.status.version, error: message, releaseUrl: this.status.releaseUrl });
    } finally {
      this.busy = false;
    }
  }

  /** At startup: a verified download from last time that's newer than this copy is ready to go. */
  async loadDownloaded(): Promise<void> {
    const dir = updatesDir();
    if (!this.key || !this.asset || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const m = /^update-(\d+\.\d+\.\d+)\.bin$/.exec(name);
      const version = m ? parseVersion(m[1]) : null;
      const file = join(dir, name);
      if (version && m && compareVersions(version, this.current) > 0 && existsSync(`${file}.sig`)) {
        const signature = Buffer.from(readFileSync(`${file}.sig`, 'utf8').trim(), 'base64');
        if (await verifyFile(this.key, file, m[1], signature)) {
          this.readyFile = file;
          this.set({ state: 'ready', version: m[1], error: null, releaseUrl: null });
          return;
        }
      }
    }
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true, recursive: true });
  }

  /**
   * Puts the waiting update in place. Windows: starts the silent installer, which stops this copy
   * itself. AppImage: swaps the file. Either way the caller quits straight after; with `relaunch`
   * the new version starts (in the tray with `tray`).
   */
  async install(relaunch: boolean, tray: boolean): Promise<boolean> {
    const file = this.readyFile;
    const version = this.status.version;
    if (!file || !version || !this.key) return false;
    try {
      // Checked again right before running it, not trusted from when it was downloaded.
      const signature = Buffer.from(readFileSync(`${file}.sig`, 'utf8').trim(), 'base64');
      if (!(await verifyFile(this.key, file, version, signature))) return false;
      if (this.kind === 'deb') {
        // apt wants a .deb by name. Purrlor comes back afterwards either way: updated, or as it
        // was if the password prompt was cancelled.
        const deb = join(updatesDir(), `purrlor_${version}_amd64.deb`);
        copyFileSync(file, deb);
        const again = relaunch ? `; exec ${shellQuote(process.execPath)}${tray ? ' --tray' : ''}` : '';
        spawn('/bin/sh', ['-c', `pkexec apt-get install -y --allow-downgrades "$1"${again}`, 'purrlor-update', deb], { detached: true, stdio: 'ignore' }).unref();
        return true;
      }
      if (isWindows) {
        const exe = join(updatesDir(), `Purrlor-Setup-${version}.exe`);
        copyFileSync(file, exe);
        const args = ['/S', ...(relaunch ? ['/RELAUNCH'] : []), ...(relaunch && tray ? ['/TRAY'] : [])];
        spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
        return true;
      }
      const target = process.env.APPIMAGE;
      if (!target) return false;
      const staged = `${target}.update`;
      copyFileSync(file, staged);
      chmodSync(staged, 0o755);
      renameSync(staged, target);
      rmSync(file, { force: true });
      rmSync(`${file}.sig`, { force: true });
      if (relaunch) app.relaunch({ execPath: target, args: tray ? ['--tray'] : [] });
      return true;
    } catch (err) {
      logError('update install', err);
      return false;
    }
  }

  private set(status: Omit<UpdateStatus, 'automatic'>): void {
    this.status = { ...status, automatic: this.canInstall };
    this.changed(this.status);
  }

  private async get(url: string): Promise<Response> {
    const res = await net.fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `PurrlorDesktop/${app.getVersion()}` },
    });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res;
  }

  private async findNewer(): Promise<Release | null> {
    const res = await this.get(`https://api.github.com/repos/${this.repository}/releases?per_page=30`);
    const releases = (await res.json()) as Array<{
      draft: boolean;
      prerelease: boolean;
      tag_name: string;
      html_url: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    }>;
    let best: { v: [number, number, number]; release: Release } | null = null;
    for (const r of releases) {
      if (r.draft || r.prerelease || !r.tag_name.startsWith(TAG_PREFIX)) continue;
      const v = parseVersion(r.tag_name.slice(TAG_PREFIX.length));
      if (!v || compareVersions(v, this.current) <= 0 || (best && compareVersions(v, best.v) <= 0)) continue;
      const asset = (name: string | null) => (name ? (r.assets.find((a) => a.name === name)?.browser_download_url ?? null) : null);
      best = {
        v,
        release: { version: v.join('.'), url: r.html_url, file: asset(this.asset), signature: asset(this.asset && `${this.asset}.sig`) },
      };
    }
    return best?.release ?? null;
  }

  private async download(version: string, fileUrl: string, signatureUrl: string): Promise<string> {
    const dir = updatesDir();
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `update-${version}.bin`);
    const partial = `${target}.download`;
    const signatureText = (await (await this.get(signatureUrl)).text()).trim();
    const signature = Buffer.from(signatureText, 'base64');
    const res = await this.get(fileUrl);
    if (!res.body) throw new Error('empty download');
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(partial));
    if (!this.key || !(await verifyFile(this.key, partial, version, signature))) {
      rmSync(partial, { force: true });
      throw new UpdateRejected(`The download of ${version} didn’t match its signature, so it wasn’t installed.`);
    }
    renameSync(partial, target);
    writeFileSync(`${target}.sig`, signatureText);
    // Only the newest is kept.
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`update-${version}.bin`)) rmSync(join(dir, name), { force: true, recursive: true });
    }
    return target;
  }
}

class UpdateRejected extends Error {}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\''`)}'`;
}
