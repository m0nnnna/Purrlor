import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  WebContentsView,
  type DesktopCapturerSource,
  type Session,
  type Streams,
} from 'electron';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { answer, event as bridgeEvent, type BridgeHost } from './bridge';
import { attachContextMenu } from './contextMenu';
import { GlobalHotkeys } from './hotkeys';
import { IdleWatch } from './idle';
import { isLinux, isWindows, legacyWebViewDir, logError } from './paths';
import { displayName, isSameOrigin, normalizeServer, probeServer } from './serverAddress';
import type { Bounds, SettingsStore } from './settings';
import { setStartOnLogin } from './autostart';
import { AppTray } from './tray';
import { Updater, type UpdateStatus } from './updater';
import type { Modal, ProbeResult, ShellState } from '../shared/types';

const TITLE_BAR_HEIGHT = 36;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const COLORS = { app: '#050607', chrome: '#0d0f12', text: '#eef1f4' };
const PARTITION = 'persist:purrlor';

// What the Purrlor web client asks for: voice/video, screen share, desktop notifications, reading
// pasted images, picking the speaker, full screen video. Only ever granted to the configured server.
const GRANTED = new Set([
  'media',
  'display-capture',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'speaker-selection',
  'fullscreen',
  'pointerLock',
]);

/** Under a Wayland compositor nothing can watch keys globally, and screen share goes through the portal. */
const isWayland =
  isLinux &&
  !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') &&
  process.env.ELECTRON_OZONE_PLATFORM_HINT !== 'x11' &&
  !process.argv.some((a) => a === '--ozone-platform=x11');

export class PurrlorApp {
  private readonly win: BrowserWindow;
  private readonly page: WebContentsView;
  private readonly session: Session;
  private readonly tray: AppTray;
  private readonly updater: Updater;
  private readonly hotkeys: GlobalHotkeys;
  private readonly idle: IdleWatch;
  private state: ShellState;
  private server: string | null;
  private allowQuit = false;
  private shellReady = false;
  private unread = 0;
  private badgeRequest = 0;
  private crashes: number[] = [];
  private pickerCallback: ((streams: Streams | null) => void) | null = null;
  private pickerSources = new Map<string, DesktopCapturerSource>();
  private saveBoundsTimer: NodeJS.Timeout | null = null;
  private promptNextDownload = false;
  private loadFailed = false;

  constructor(
    private readonly settings: SettingsStore,
    private readonly startHidden: boolean
  ) {
    const normalized = normalizeServer(settings.get().serverUrl);
    this.server = normalized.ok ? normalized.origin : null;
    this.session = session.fromPartition(PARTITION);

    this.updater = new Updater((status) => this.onUpdateStatus(status));
    this.hotkeys = new GlobalHotkeys((id, down) => this.postEvent('hotkey', { id, down }), !isWayland);
    this.idle = new IdleWatch((idle) => this.postEvent('idle', { idle }));

    this.state = {
      platform: process.platform,
      version: app.getVersion(),
      title: 'Purrlor',
      server: this.server ? { origin: this.server, name: displayName(this.server) } : null,
      view: this.server ? 'loading' : 'connect',
      firstRun: !this.server,
      error: null,
      modal: null,
      backdrop: null,
      update: this.updater.status,
      maximized: false,
      focused: true,
      fullscreen: false,
    };

    // Before the page exists, so it starts with the session's user agent and handlers.
    this.configureSession();
    this.win = this.createWindow();
    this.page = this.createPage();
    this.win.contentView.addChildView(this.page);
    this.registerIpc();
    this.tray = new AppTray({
      show: () => this.show(),
      changeServer: () => {
        this.show();
        this.changeServer();
      },
      setStartOnLogin: (on) => this.setStartOnLogin(on),
      checkForUpdates: () => void this.updater.check(),
      installUpdate: () => void this.installUpdate(true),
      quit: () => void this.quit(),
    });
    this.refreshTray();
    this.layout();

    // Keep the login entry pointing at wherever this copy is installed now.
    if (settings.get().startOnLogin) setStartOnLogin(true);
  }

  async start(): Promise<void> {
    await this.updater.loadDownloaded().catch((err) => logError('update load', err));
    // Signing in with an update waiting: install it before anyone's using Purrlor.
    if (this.startHidden && this.updater.installsQuietly && this.updater.status.state === 'ready' && (await this.updater.install(true, true))) {
      this.allowQuit = true;
      app.quit();
      return;
    }
    this.updater.schedule(this.settings.get().autoUpdate);
    void this.win.webContents.loadFile(join(__dirname, 'shell', 'index.html'));
    if (this.server) this.navigate();
  }

  // ---- The window -------------------------------------------------------------------------

  private createWindow(): BrowserWindow {
    const saved = this.settings.get();
    const bounds = validBounds(saved.bounds);
    const win = new BrowserWindow({
      ...(bounds ?? { width: 1280, height: 820 }),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      title: 'Purrlor',
      backgroundColor: COLORS.app,
      icon: isLinux ? join(__dirname, 'icon.png') : undefined,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: COLORS.chrome, symbolColor: COLORS.text, height: TITLE_BAR_HEIGHT },
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, 'preload-shell.js'),
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setMenu(null);
    win.webContents.on('render-process-gone', (_e, details) => {
      logError('shell process', details.reason);
      if (!this.allowQuit && details.reason !== 'clean-exit') win.webContents.reload();
    });
    if (!app.isPackaged) {
      win.webContents.on('console-message', (e) => console.log(`[shell] ${e.message}`));
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.once('ready-to-show', () => {
      if (this.startHidden) return;
      if (saved.maximized) win.maximize();
      win.show();
    });
    win.on('close', (e) => {
      if (this.allowQuit) return;
      e.preventDefault();
      if (this.settings.get().closeToTray) this.hideToTray();
      else void this.quit();
    });
    const resized = () => {
      this.layout();
      this.scheduleSaveBounds();
    };
    win.on('resize', resized);
    win.on('move', () => this.scheduleSaveBounds());
    win.on('maximize', () => {
      this.setState({ maximized: true });
      this.scheduleSaveBounds();
    });
    win.on('unmaximize', () => {
      this.setState({ maximized: false });
      this.scheduleSaveBounds();
    });
    win.on('enter-full-screen', () => this.setState({ fullscreen: true }));
    win.on('leave-full-screen', () => this.setState({ fullscreen: false }));
    win.on('focus', () => {
      this.setState({ focused: true });
      if (this.pageVisible()) this.page.webContents.focus();
    });
    win.on('blur', () => this.setState({ focused: false }));
    return win;
  }

  private createPage(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'preload-page.js'),
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor(COLORS.app);
    view.setVisible(false);
    const contents = view.webContents;
    contents.setZoomFactor(1);

    contents.on('did-start-navigation', (details) => {
      // A new page (a reload, another server) sets its own keybinds when it joins a call.
      if (details.isMainFrame && !details.isSameDocument) {
        this.loadFailed = false;
        this.hotkeys.clear();
        this.idle.watch(0);
      }
    });
    contents.on('did-finish-load', () => {
      // A failed load still "finishes", with Chromium's error page under the failed address.
      if (this.loadFailed || !this.server || !isSameOrigin(contents.getURL(), this.server)) return;
      this.crashes = this.crashes.filter((t) => Date.now() - t < 60_000);
      if (this.state.view === 'loading' || this.state.view === 'error' || this.state.view === 'crashed') {
        this.setState({ view: 'page', error: null });
      }
      this.maybeShowMigrationNotice();
    });
    contents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED: we sent a link to the browser ourselves, or a newer load replaced this one.
      if (!isMainFrame || code === -3) return;
      this.loadFailed = true;
      this.setState({
        view: 'error',
        error: { title: `Couldn’t reach ${this.server ? displayName(this.server) : 'the server'}`, detail: friendlyError(code, description) },
      });
    });
    contents.on('page-title-updated', (e, title) => {
      e.preventDefault();
      const shown = title && this.state.view === 'page' ? title : 'Purrlor';
      this.win.setTitle(shown);
      this.setState({ title: shown });
    });
    contents.on('render-process-gone', (_e, details) => {
      if (this.allowQuit || details.reason === 'clean-exit') return;
      logError('page process', details.reason);
      this.crashes = [...this.crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
      if (this.crashes.length >= 3) {
        this.setState({ view: 'crashed', error: { title: 'Purrlor keeps stopping', detail: `The page stopped unexpectedly (${details.reason}).` } });
        return;
      }
      this.navigate();
    });
    contents.on('unresponsive', () => logError('page', 'unresponsive'));

    // Links to anywhere but the server open in the browser. Same-server pop-ups, including the
    // about:blank window the screen-share pop-out writes into, stay Purrlor windows.
    contents.on('will-navigate', (e, url) => {
      if (this.server && isSameOrigin(url, this.server)) return;
      e.preventDefault();
      this.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if ((this.server && isSameOrigin(url, this.server)) || url === 'about:blank') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            backgroundColor: COLORS.app,
            autoHideMenuBar: true,
            icon: isLinux ? join(__dirname, 'icon.png') : undefined,
            webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
          },
        };
      }
      this.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('did-create-window', (child) => {
      child.setMenu(null);
      attachContextMenu(child.webContents, this.contextMenuActions());
    });

    contents.on('enter-html-full-screen', () => this.setState({ fullscreen: true }));
    contents.on('leave-html-full-screen', () => this.setState({ fullscreen: false }));
    contents.on('zoom-changed', (_e, direction) => this.zoom(direction === 'in' ? 0.1 : -0.1));
    contents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const mod = input.control || input.meta;
      const key = input.key.toLowerCase();
      if (mod && (key === '=' || key === '+')) this.zoom(0.1);
      else if (mod && key === '-') this.zoom(-0.1);
      else if (mod && key === '0') contents.setZoomFactor(1);
      else if (input.key === 'F5' || (mod && key === 'r')) {
        if (input.shift) contents.reloadIgnoringCache();
        else contents.reload();
      } else if (input.key === 'F11') this.win.setFullScreen(!this.win.isFullScreen());
      else if ((mod && input.shift && key === 'i') || input.key === 'F12') {
        if (!app.isPackaged || process.env.PURRLOR_DEVTOOLS === '1') contents.toggleDevTools();
        else return;
      } else if (isLinux && mod && key === 'q') void this.quit();
      else return;
      e.preventDefault();
    });
    attachContextMenu(contents, this.contextMenuActions());
    return view;
  }

  private zoom(delta: number): void {
    const contents = this.page.webContents;
    contents.setZoomFactor(Math.min(3, Math.max(0.5, Math.round((contents.getZoomFactor() + delta) * 10) / 10)));
  }

  private configureSession(): void {
    const s = this.session;
    const ua = s.getUserAgent().replace(/\s(Electron|Purrlor|purrlor-desktop)\/\S+/gi, '');
    s.setUserAgent(`${ua} PurrlorDesktop/${app.getVersion()}`);
    s.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = details.requestingUrl || contents.getURL();
      callback(!!this.server && GRANTED.has(permission) && isSameOrigin(origin, this.server));
    });
    s.setPermissionCheckHandler((_contents, permission, origin) => !!this.server && GRANTED.has(permission) && isSameOrigin(origin, this.server));
    s.setDisplayMediaRequestHandler((request, callback) => void this.pickDisplayMedia(request.securityOrigin, request.audioRequested, callback));
    s.on('will-download', (_e, item) => {
      const name = safeFileName(item.getFilename());
      if (this.promptNextDownload) {
        this.promptNextDownload = false;
        item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), name) });
      } else {
        item.setSavePath(uniquePath(join(app.getPath('downloads'), name)));
      }
      item.once('done', (_e2, state) => {
        if (state !== 'completed') return;
        const path = item.getSavePath();
        this.notify('Download complete', basename(path), () => shell.showItemInFolder(path));
      });
    });
    try {
      const locale = app.getLocale();
      const available = s.availableSpellCheckerLanguages;
      const langs = [locale, locale.split('-')[0], 'en-US'].filter((l, i, all) => available.includes(l) && all.indexOf(l) === i);
      if (!isWindows && langs.length > 0) s.setSpellCheckerLanguages(langs.slice(0, 1));
    } catch {
      // Spellcheck stays on its defaults.
    }
  }

  // ---- The shell page and its state ---------------------------------------------------------

  private setState(change: Partial<ShellState>): void {
    this.state = { ...this.state, ...change };
    if (this.shellReady && !this.win.isDestroyed()) this.win.webContents.send('shell:state', this.state);
    this.layout();
  }

  private pageVisible(): boolean {
    return this.state.view === 'page' && this.state.modal === null;
  }

  private layout(): void {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const top = this.state.fullscreen ? 0 : TITLE_BAR_HEIGHT;
    this.page.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    const visible = this.pageVisible();
    this.page.setVisible(visible);
    if (visible && this.win.isFocused() && !this.page.webContents.isFocused()) this.page.webContents.focus();
  }

  private async openModal(modal: Modal): Promise<void> {
    let backdrop = this.state.backdrop;
    if (this.pageVisible()) {
      backdrop = null;
      // The compositor now and then has no frame to hand over the first time; a second try gets one.
      for (let attempt = 0; attempt < 2 && !backdrop; attempt++) {
        try {
          const image = await this.page.webContents.capturePage();
          if (!image.isEmpty()) backdrop = `data:image/jpeg;base64,${image.resize({ width: Math.min(1280, image.getSize().width) }).toJPEG(70).toString('base64')}`;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
    }
    this.setState({ modal, backdrop });
  }

  private closeModal(): void {
    this.setState({ modal: null, backdrop: null });
  }

  private registerIpc(): void {
    const fromShell = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => e.sender === this.win.webContents;
    ipcMain.on('shell:ready', (e) => {
      if (!fromShell(e)) return;
      this.shellReady = true;
      this.setState({});
      this.drawBadge();
    });
    ipcMain.handle('shell:probe', async (e, address: unknown): Promise<ProbeResult> => {
      if (!fromShell(e)) return { ok: false, error: 'Not allowed.' };
      const n = normalizeServer(typeof address === 'string' ? address : '');
      if (!n.ok) return n;
      const problem = await probeServer(n.origin, (url, init) => this.session.fetch(url, init));
      return { ok: true, origin: n.origin, name: displayName(n.origin), problem };
    });
    ipcMain.on('shell:connect', (e, origin: unknown) => {
      if (!fromShell(e) || typeof origin !== 'string') return;
      const n = normalizeServer(origin);
      if (n.ok) this.connect(n.origin);
    });
    ipcMain.on('shell:cancel-modal', (e) => {
      if (!fromShell(e)) return;
      if (this.state.modal?.kind === 'picker') this.finishPicker(null);
      if (this.state.modal?.kind === 'notice') this.settings.update({ migrationNoticePending: false });
      this.closeModal();
    });
    ipcMain.on('shell:retry', (e) => fromShell(e) && this.navigate());
    ipcMain.on('shell:change-server', (e) => fromShell(e) && this.changeServer());
    ipcMain.on('shell:picker-choose', (e, id: unknown, audio: unknown) => {
      if (!fromShell(e) || typeof id !== 'string') return;
      const source = this.pickerSources.get(id);
      this.finishPicker(source ? { video: source, ...(audio === true && isWindows ? { audio: 'loopback' as const } : {}) } : null);
      this.closeModal();
    });
    ipcMain.on('shell:install-update', (e) => fromShell(e) && void this.installUpdate(true));
    ipcMain.on('shell:dismiss-notice', (e) => {
      if (!fromShell(e)) return;
      this.settings.update({ migrationNoticePending: false });
      this.closeModal();
    });
    ipcMain.on('shell:open-external', (e, url: unknown) => fromShell(e) && typeof url === 'string' && this.openExternal(url));
    ipcMain.on('shell:badge-drawn', (e, id: unknown, overlay: unknown, tray: unknown) => {
      if (!fromShell(e) || id !== this.badgeRequest) return;
      if (typeof tray === 'string') this.tray.setImage(nativeImage.createFromDataURL(tray));
      if (isWindows) {
        const image = typeof overlay === 'string' ? nativeImage.createFromDataURL(overlay) : null;
        this.win.setOverlayIcon(image, this.unread > 0 ? `${this.unread} unread` : '');
      }
    });

    // The page's side of the bridge: only the configured server's own top-level page is answered.
    ipcMain.on('page:bridge', (e, text: unknown) => {
      if (e.sender !== this.page.webContents || typeof text !== 'string') return;
      const frame = e.senderFrame;
      if (!frame || frame.parent !== null || !this.server || !isSameOrigin(frame.url, this.server)) return;
      const reply = answer(this.bridgeHost(), text, (method, err) => logError(`bridge ${String(method)}`, err));
      if (reply) this.page.webContents.send('page:bridge', JSON.stringify(reply));
    });
    ipcMain.on('page:focus', (e) => {
      if (e.sender === this.page.webContents) this.show();
    });
  }

  private bridgeHost(): BridgeHost {
    return {
      version: app.getVersion(),
      platform: process.platform,
      settings: () => this.bridgeSettings(),
      setSetting: (name, value) => {
        if (name === 'startWithWindows') this.setStartOnLogin(value);
        else if (name === 'closeToTray') this.settings.update({ closeToTray: value });
        else if (name === 'autoUpdate') {
          this.settings.update({ autoUpdate: value });
          this.updater.schedule(value);
        }
      },
      setHotkeys: (bindings) => this.hotkeys.set(bindings),
      setBadge: (count) => this.setBadge(count),
      watchIdle: (minutes) => this.idle.watch(minutes),
      update: () => this.updater.status,
      checkForUpdates: () => void this.updater.check(),
      installUpdate: () => setImmediate(() => void this.installUpdate(true)),
      changeServer: () => setImmediate(() => this.changeServer()),
    };
  }

  private bridgeSettings() {
    const s = this.settings.get();
    return { startWithWindows: s.startOnLogin, closeToTray: s.closeToTray, autoUpdate: s.autoUpdate };
  }

  private postEvent(name: string, data: unknown): void {
    const contents = this.page.webContents;
    if (contents.isDestroyed() || !this.server || !isSameOrigin(contents.getURL(), this.server)) return;
    contents.send('page:bridge', JSON.stringify(bridgeEvent(name, data)));
  }

  // ---- What the app does ----------------------------------------------------------------------

  private navigate(): void {
    if (!this.server) return;
    this.setState({ view: 'loading', error: null, title: 'Purrlor' });
    this.win.setTitle('Purrlor');
    this.page.webContents.loadURL(this.server).catch(() => {
      // did-fail-load shows it.
    });
  }

  private changeServer(): void {
    if (this.state.view === 'connect') return;
    void this.openModal({ kind: 'connect' });
  }

  private connect(origin: string): void {
    // Each server keeps its own sign-in and encryption keys (browser storage is per origin), so
    // switching back later picks up where that server left off.
    const changed = origin !== this.server;
    this.server = origin;
    this.settings.update({ serverUrl: origin });
    this.setState({ server: { origin, name: displayName(origin) }, firstRun: false, modal: null, backdrop: null });
    this.refreshTray();
    if (changed || this.state.view !== 'page') this.navigate();
  }

  private setStartOnLogin(on: boolean): void {
    if (this.settings.get().startOnLogin === on) return;
    this.settings.update({ startOnLogin: on });
    setStartOnLogin(on);
    this.refreshTray();
    this.postEvent('settings', this.bridgeSettings());
  }

  private setBadge(count: number): void {
    if (count === this.unread) return;
    this.unread = count;
    if (isLinux) app.setBadgeCount(count);
    this.drawBadge();
    this.refreshTray();
  }

  /** The shell page draws the taskbar overlay and the tray icon's dot (there's no canvas here). */
  private drawBadge(): void {
    if (!this.shellReady) return;
    this.badgeRequest++;
    this.win.webContents.send('shell:draw-badge', { id: this.badgeRequest, count: this.unread });
  }

  private onUpdateStatus(status: UpdateStatus): void {
    const wasReady = this.state.update.state === 'ready';
    this.setState({ update: status });
    this.refreshTray();
    this.postEvent('update', status);
    if (status.state === 'ready' && !wasReady) {
      const when = this.updater.installsQuietly ? 'Restart Purrlor to update, or it updates next time you quit it.' : 'Restart Purrlor to update; it asks for your password to install it.';
      this.notify(`Purrlor ${status.version} is ready`, when, () => this.show());
    }
  }

  private async installUpdate(relaunch: boolean): Promise<void> {
    if (!(await this.updater.install(relaunch, false))) {
      this.notify('Couldn’t update Purrlor', 'The downloaded update didn’t check out. Purrlor will try again later.');
      return;
    }
    this.allowQuit = true;
    app.quit();
  }

  /** Quits; a downloaded update installs on the way out (it's quiet and quick). */
  async quit(): Promise<void> {
    if (this.updater.installsQuietly && this.updater.status.state === 'ready') await this.updater.install(false, false);
    this.allowQuit = true;
    app.quit();
  }

  /** Called from app's before-quit: the system is shutting down, or something else asked. */
  allowQuitting(): void {
    this.allowQuit = true;
  }

  show(): void {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    if (!this.win.isVisible()) {
      if (this.settings.get().maximized) this.win.maximize();
      this.win.show();
    }
    this.win.focus();
  }

  private hideToTray(): void {
    this.saveBounds();
    this.win.hide();
    if (!this.settings.get().trayHintShown) {
      this.settings.update({ trayHintShown: true });
      this.notify(
        'Purrlor is still running',
        isWindows
          ? 'It stays in the tray so you keep getting notifications. Right-click the tray icon to quit.'
          : 'It stays in the top bar so you keep getting notifications. Open its menu there to quit.'
      );
    }
  }

  private refreshTray(): void {
    this.tray.update({
      serverName: this.server ? displayName(this.server) : null,
      unread: this.unread,
      startOnLogin: this.settings.get().startOnLogin,
      update: this.updater.status,
    });
  }

  private maybeShowMigrationNotice(): void {
    if (!this.settings.get().migrationNoticePending || this.state.modal) return;
    if (!existsSync(legacyWebViewDir())) {
      this.settings.update({ migrationNoticePending: false });
      return;
    }
    void this.openModal({
      kind: 'notice',
      title: 'Welcome to the new Purrlor desktop app',
      body:
        'Purrlor desktop now runs on a new engine, on Windows and Linux alike. Sign-ins couldn’t come across from the old app, so please sign in again. ' +
        'If you use encrypted chats, have your recovery key or passphrase ready to unlock your message history.',
    });
  }

  private async pickDisplayMedia(origin: string, audioRequested: boolean, callback: (streams: Streams | null) => void): Promise<void> {
    if (!this.server || !isSameOrigin(origin, this.server)) {
      callback(null);
      return;
    }
    // A request still waiting on the picker loses to the new one.
    this.finishPicker(null);
    try {
      if (isWayland) {
        // The compositor's own portal asks which screen or window; it hands back just that one.
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        callback(sources[0] ? { video: sources[0] } : null);
        return;
      }
      const own = this.win.getMediaSourceId();
      const sources = (
        await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: true })
      ).filter((s) => s.id !== own);
      this.pickerSources = new Map(sources.map((s) => [s.id, s]));
      this.pickerCallback = callback;
      this.show();
      await this.openModal({
        kind: 'picker',
        audio: audioRequested && isWindows,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        })),
      });
    } catch (err) {
      logError('screen share', err);
      this.finishPicker(null);
      callback(null);
    }
  }

  private finishPicker(streams: Streams | null): void {
    const callback = this.pickerCallback;
    this.pickerCallback = null;
    this.pickerSources.clear();
    if (callback) {
      try {
        callback(streams);
      } catch (err) {
        logError('screen share answer', err);
      }
    }
  }

  private notify(title: string, body: string, onClick?: () => void): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: isLinux ? join(__dirname, 'icon.png') : undefined });
    if (onClick) n.on('click', onClick);
    n.show();
  }

  openExternal(url: string): void {
    // Only real links go to the system, never file:, or other protocol handlers a page could
    // otherwise launch.
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.toString());
    } catch {
      // Not a link.
    }
  }

  private contextMenuActions() {
    return {
      openExternal: (url: string) => this.openExternal(url),
      beforeSaveAs: () => {
        this.promptNextDownload = true;
      },
    };
  }

  private scheduleSaveBounds(): void {
    if (this.saveBoundsTimer) clearTimeout(this.saveBoundsTimer);
    this.saveBoundsTimer = setTimeout(() => this.saveBounds(), 500);
  }

  private saveBounds(): void {
    if (this.win.isDestroyed() || this.win.isFullScreen() || this.win.isMinimized()) return;
    const maximized = this.win.isMaximized();
    const bounds = this.win.getNormalBounds();
    this.settings.update({
      maximized,
      bounds: bounds.width >= MIN_WIDTH && bounds.height >= MIN_HEIGHT ? bounds : this.settings.get().bounds,
    });
  }

  dispose(): void {
    this.saveBounds();
    this.hotkeys.dispose();
    this.idle.dispose();
    this.updater.dispose();
    this.tray.destroy();
  }
}

function validBounds(b: Bounds | null): Bounds | null {
  if (!b || b.width < MIN_WIDTH || b.height < MIN_HEIGHT) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 64 && b.x + b.width > a.x + 64 && b.y >= a.y - 8 && b.y < a.y + a.height - 64;
  });
  return visible ? b : null;
}

function friendlyError(code: number, description: string): string {
  switch (code) {
    case -105:
      return 'The server’s name couldn’t be found. Check the address, or your internet connection.';
    case -106:
      return 'You seem to be offline.';
    case -102:
    case -109:
    case -118:
      return 'The server didn’t answer.';
    case -200:
    case -201:
    case -202:
      return 'The server’s certificate isn’t valid, so Purrlor didn’t connect.';
    default:
      return description ? description.replace(/^net::/, '') : 'Something went wrong while loading.';
  }
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned || 'Purrlor-download';
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}
