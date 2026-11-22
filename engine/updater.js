// Built-In Apple-Grade Software Updater (GitHub Releases + Semver + SHA-256 + Pre-Update Backup).
//
// Official feed URL is baked in directly — users only see clean Apple Auto-Update toggles.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const OFFICIAL_UPDATE_FEED_URL =
  process.env.STREAM_TIMER_UPDATE_URL ||
  'https://github.com/AyoSan12/stream-timer-desktop/releases/latest/download/latest.json';

function readAppVersion() {
  try {
    const pkgPath = path.join(HERE, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  } catch { /* embedded runtime fallback */ }
  return '1.0.0';
}

export const APP_VERSION = readAppVersion();

export function compareSemver(a, b) {
  const parse = (v) => String(v || '0.0.0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

export function createUpdateManager({ dataDir, getUpdateConfig, exportAllProfilesBackup, logger = () => {} }) {
  let state = {
    currentVersion: APP_VERSION,
    status: 'idle', // 'idle' | 'checking' | 'up_to_date' | 'update_available' | 'downloading' | 'ready_to_install' | 'error'
    latestVersion: null,
    notes: '',
    publishedAt: null,
    downloadUrl: '',
    sha256: '',
    stagedPath: '',
    lastCheckedAtMs: 0,
    lastError: null,
    backupDir: '',
  };

  async function checkNow(overrideFeedUrl = '') {
    const feedUrl = (overrideFeedUrl || OFFICIAL_UPDATE_FEED_URL).trim();
    state.lastCheckedAtMs = Date.now();
    state.lastError = null;
    state.status = 'checking';

    try {
      let manifest;
      if (feedUrl.startsWith('file://')) {
        const filePath = fileURLToPath(feedUrl);
        manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } else {
        const parsedUrl = new URL(feedUrl);
        if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== 'localhost') {
          throw new Error('Update feed must use HTTPS');
        }
        const res = await fetch(feedUrl, {
          redirect: 'follow',
          headers: { accept: 'application/json', 'user-agent': `StreamTimer/${APP_VERSION}` },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} checking for updates`);
        manifest = await res.json();
      }

      const latest = typeof manifest?.version === 'string' ? manifest.version.trim().replace(/^v/i, '') : '';
      const win = manifest?.windows || manifest?.platforms?.['windows-x86_64'] || {};
      const dlUrl = typeof win.url === 'string' ? win.url.trim() : '';
      const sha = typeof win.sha256 === 'string' ? win.sha256.trim().toLowerCase() : '';

      if (!latest) throw new Error('Invalid release manifest: missing version');

      state.latestVersion = latest;
      state.notes = typeof manifest.notes === 'string' ? manifest.notes.slice(0, 4000) : '';
      state.publishedAt = typeof manifest.publishedAt === 'string' ? manifest.publishedAt : null;
      state.downloadUrl = dlUrl;
      state.sha256 = sha;

      if (compareSemver(latest, APP_VERSION) > 0) {
        if (!dlUrl || !/^[a-f0-9]{64}$/.test(sha)) {
          throw new Error('Release manifest missing verified Windows binary URL or SHA-256');
        }
        state.status = 'update_available';
      } else {
        state.status = 'up_to_date';
      }
      logger('update_checked', { current: APP_VERSION, latest, status: state.status });
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
    }
    return getStatus();
  }

  async function downloadAndStage() {
    if (!state.downloadUrl || !/^[a-f0-9]{64}$/.test(state.sha256)) {
      return { ok: false, error: 'no_verified_update_available' };
    }

    state.status = 'downloading';
    state.lastError = null;
    try {
      // 1. Automatic pre-update safety backup of ALL profiles before touching any binary
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupDir = path.join(dataDir, 'backups', `pre-update-v${APP_VERSION}-${stamp}`);
      fs.mkdirSync(backupDir, { recursive: true });
      const bundles = exportAllProfilesBackup();
      for (const b of bundles) {
        const slug = (b.profile?.name || b.profile?.id || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
        fs.writeFileSync(path.join(backupDir, `${slug}.stbackup`), JSON.stringify(b, null, 2), 'utf8');
      }
      state.backupDir = backupDir;

      // 2. Download binary & verify exact SHA-256 checksum
      let buf;
      if (state.downloadUrl.startsWith('file://')) {
        buf = fs.readFileSync(fileURLToPath(state.downloadUrl));
      } else {
        const parsedUrl = new URL(state.downloadUrl);
        if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== 'localhost') {
          throw new Error('Download URL must use HTTPS');
        }
        const res = await fetch(state.downloadUrl, {
          redirect: 'follow',
          headers: { 'user-agent': `StreamTimer/${APP_VERSION}` },
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
        buf = Buffer.from(await res.arrayBuffer());
      }

      const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
      if (actualSha !== state.sha256) {
        throw new Error(`SHA-256 verification failed (expected ${state.sha256.slice(0, 12)}…, got ${actualSha.slice(0, 12)}…)`);
      }

      const updatesDir = path.join(dataDir, 'updates');
      fs.mkdirSync(updatesDir, { recursive: true });
      const stagedPath = path.join(updatesDir, `StreamTimer-v${state.latestVersion}.exe`);
      fs.writeFileSync(stagedPath, buf);

      state.stagedPath = stagedPath;
      state.status = 'ready_to_install';
      logger('update_staged', { version: state.latestVersion, bytes: buf.length, sha256: actualSha });
      return { ok: true, status: getStatus() };
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
      return { ok: false, error: state.lastError, status: getStatus() };
    }
  }

  function getStatus() {
    const cfg = getUpdateConfig();
    return {
      ...state,
      autoCheck: cfg.autoCheck !== false,
      autoInstall: Boolean(cfg.autoInstall),
    };
  }

  return { checkNow, downloadAndStage, getStatus };
}
