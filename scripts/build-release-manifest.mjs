// Helper to generate a verified `latest.json` release manifest for Stream Timer's Built-In Updater.
// Usage:
//   node scripts/build-release-manifest.mjs --version 1.0.0 --url "https://github.com/AyoSan12/stream-timer-desktop/releases/download/v1.0.0/Stream-Timer.exe" --notes "Initial release"

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const exePath = path.join(ROOT, 'Stream Timer.exe');

if (!fs.existsSync(exePath)) {
  console.error('Stream Timer.exe not found at', exePath);
  process.exit(1);
}

const args = process.argv.slice(2);
const argVal = (flag, fb = '') => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fb;
};

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
const version = argVal('--version', pkg.version || '1.0.0').replace(/^v/i, '');
const downloadUrl = argVal(
  '--url',
  `https://github.com/AyoSan12/stream-timer-desktop/releases/download/v${version}/Stream-Timer.exe`,
);
const notes = argVal('--notes', `Stream Timer v${version} — Native Windows Release`);

const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  notes,
  windows: {
    url: downloadUrl,
    sha256,
  },
};

const outPath = path.join(ROOT, 'latest.json');
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('Generated release manifest:', outPath);
console.log(JSON.stringify(manifest, null, 2));
