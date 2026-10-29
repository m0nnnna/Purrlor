// Windows: packs dist-app\win-unpacked (from `electron-builder --win dir`) into
// dist-app\Purrlor-Setup.exe with installer\Purrlor.nsi.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version must be MAJOR.MINOR.PATCH, got ${version}`);
if (!existsSync(join(root, 'dist-app', 'win-unpacked', 'Purrlor.exe'))) throw new Error('Run `electron-builder --win dir` first.');

function findMakensis() {
  try {
    execFileSync('makensis', ['/VERSION'], { stdio: 'ignore' });
    return 'makensis';
  } catch {
    // Not on PATH.
  }
  for (const dir of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    const candidate = dir && join(dir, 'NSIS', 'makensis.exe');
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error('NSIS not found. Install it from https://nsis.sourceforge.io or put makensis on PATH.');
}

execFileSync(findMakensis(), [`/DAPPVERSION=${version}`, 'Purrlor.nsi'], { cwd: join(root, 'installer'), stdio: 'inherit' });
console.log(`Purrlor ${version} installer: ${join(root, 'dist-app', 'Purrlor-Setup.exe')}`);
