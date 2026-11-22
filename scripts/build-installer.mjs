// Builds both the Windows NSIS Installer (Stream-Timer-Setup.exe with bundled Node 24)
// and the Portable/Updater executable (Stream Timer.exe) into the repo root.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TAURI_DIR = path.join(ROOT, 'src-tauri');
const BIN_DIR = path.join(TAURI_DIR, 'bin');
const STAGED_NODE = path.join(BIN_DIR, 'node.exe');
const INSTALLER_CONF = path.join(TAURI_DIR, 'tauri.installer.conf.json');

fs.mkdirSync(BIN_DIR, { recursive: true });
fs.copyFileSync(process.execPath, STAGED_NODE);
console.log(`Staged Node.js ${process.version} -> ${STAGED_NODE}`);

try {
  execSync(`cargo tauri build --bundles nsis --config "${INSTALLER_CONF}"`, {
    cwd: TAURI_DIR,
    stdio: 'inherit',
  });
} finally {
  // Keep repo clean; src-tauri/bin is also gitignored
  try { fs.rmSync(BIN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

const builtExe = path.join(TAURI_DIR, 'target', 'release', 'stream-timer-desktop.exe');
const rootExe = path.join(ROOT, 'Stream Timer.exe');
fs.copyFileSync(builtExe, rootExe);

const nsisDir = path.join(TAURI_DIR, 'target', 'release', 'bundle', 'nsis');
const setupFiles = fs.existsSync(nsisDir)
  ? fs.readdirSync(nsisDir).filter((f) => f.toLowerCase().endsWith('-setup.exe'))
  : [];
if (setupFiles.length === 0) {
  throw new Error(`No NSIS *-setup.exe found in ${nsisDir}`);
}
const builtSetup = path.join(nsisDir, setupFiles[0]);
const rootSetup = path.join(ROOT, 'Stream-Timer-Setup.exe');
fs.copyFileSync(builtSetup, rootSetup);

const mb = (p) => `${(fs.statSync(p).size / 1048576).toFixed(2)} MB`;
console.log(`\nBuilt Portable/Updater Binary : ${rootExe} (${mb(rootExe)})`);
console.log(`Built Windows NSIS Installer  : ${rootSetup} (${mb(rootSetup)})`);
