// 1-Click Local Webhook Tunnel Manager (Cloudflare Quick Tunnel or Custom HTTPS URL).
//
// Outbound WebSockets (Streamlabs, StreamElements, Trakteer WS, TipeeeStream,
// DonationAlerts) work 100% locally with zero setup.
// For inbound webhook platforms (Saweria, Tako.id, SociaBuzz, Ko-fi, Buy Me a Coffee,
// Tiltify, Chzzk, LivePix, ECPay), this manager either:
//   1. Spawns `cloudflared tunnel --url http://127.0.0.1:<port>` (auto-locating
//      system PATH or <dataDir>/bin/cloudflared.exe, with optional 1-click download), OR
//   2. Uses a user-configured custom public HTTPS URL (reverse proxy / ngrok / domain).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const CLOUDFLARED_WIN_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

export function createTunnelManager({ dataDir, getLocalPort, logger = () => {} }) {
  let child = null;
  let customUrl = '';
  let state = {
    mode: 'off', // 'off' | 'custom' | 'cloudflared'
    status: 'stopped', // 'stopped' | 'downloading' | 'starting' | 'active' | 'error'
    publicUrl: '',
    lastError: null,
    binaryAvailable: false,
  };

  function localBinPath() {
    return path.join(dataDir, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  function findBinary() {
    const local = localBinPath();
    if (fs.existsSync(local)) return local;
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const out = execFileSync(cmd, ['cloudflared'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const first = out.split(/\r?\n/)[0]?.trim();
      if (first && fs.existsSync(first)) return first;
    } catch { /* not on PATH */ }
    return null;
  }

  state.binaryAvailable = Boolean(findBinary());

  function stopProcess() {
    if (child) {
      const ref = child;
      child = null;
      try { ref.kill(); } catch { /* ignore */ }
    }
  }

  async function ensureBinary() {
    const existing = findBinary();
    if (existing) { state.binaryAvailable = true; return existing; }
    if (process.platform !== 'win32') {
      throw new Error('cloudflared binary not found on PATH');
    }
    state.status = 'downloading';
    state.lastError = null;
    const target = localBinPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const res = await fetch(CLOUDFLARED_WIN_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Failed to download cloudflared (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    state.binaryAvailable = true;
    logger('tunnel_binary_downloaded', { bytes: buf.length });
    return target;
  }

  async function startCloudflared() {
    stopProcess();
    state.mode = 'cloudflared';
    state.lastError = null;
    state.publicUrl = '';
    try {
      const bin = await ensureBinary();
      state.status = 'starting';
      const localUrl = `http://127.0.0.1:${getLocalPort()}`;
      const proc = spawn(bin, ['tunnel', '--url', localUrl, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child = proc;

      const handleChunk = (chunk) => {
        const text = String(chunk || '');
        const m = text.match(TRYCLOUDFLARE_RE);
        if (m && proc === child) {
          state.publicUrl = m[0].replace(/\/+$/, '');
          state.status = 'active';
          state.lastError = null;
          logger('tunnel_active', { publicUrl: state.publicUrl });
        }
      };
      proc.stdout.on('data', handleChunk);
      proc.stderr.on('data', handleChunk);
      proc.on('exit', (code) => {
        if (proc === child) {
          child = null;
          if (state.mode === 'cloudflared') {
            state.status = 'stopped';
            state.publicUrl = '';
            if (code !== 0 && code !== null) state.lastError = `Tunnel exited with code ${code}`;
          }
        }
      });

      // Wait up to 12s for URL discovery
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && proc === child && !state.publicUrl) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!state.publicUrl && proc === child) {
        state.lastError = 'Timed out waiting for Cloudflare Quick Tunnel URL';
        state.status = 'error';
      }
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
    }
    return getStatus();
  }

  function setCustomUrl(url) {
    stopProcess();
    const clean = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    if (!clean) {
      customUrl = '';
      state.mode = 'off';
      state.status = 'stopped';
      state.publicUrl = '';
      state.lastError = null;
      return getStatus();
    }
    try {
      const parsed = new URL(clean);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Must start with https://');
      customUrl = clean;
      state.mode = 'custom';
      state.status = 'active';
      state.publicUrl = clean;
      state.lastError = null;
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || 'Invalid URL');
    }
    return getStatus();
  }

  function stop() {
    stopProcess();
    customUrl = '';
    state.mode = 'off';
    state.status = 'stopped';
    state.publicUrl = '';
    state.lastError = null;
    return getStatus();
  }

  function getStatus() {
    state.binaryAvailable = Boolean(findBinary());
    return {
      ...state,
      effectiveBaseUrl: state.publicUrl || `http://127.0.0.1:${getLocalPort()}`,
      customUrl,
    };
  }

  return { startCloudflared, setCustomUrl, stop, getStatus };
}
