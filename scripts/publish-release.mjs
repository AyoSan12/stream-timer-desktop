// 1-Command Release Publisher for AyoSan12/stream-timer-desktop.
// Bumps version, runs tests, compiles Stream Timer.exe, generates latest.json,
// pushes commit & tag, and publishes Stream-Timer.exe + latest.json to GitHub Releases.
//
// Usage:
//   node scripts/publish-release.mjs --version 1.0.1 --notes "Bug fixes & polish"

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OWNER = 'AyoSan12';
const REPO = 'stream-timer-desktop';

const args = process.argv.slice(2);
const argVal = (flag, fb = '') => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fb;
};

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = argVal('--version', pkg.version).replace(/^v/i, '');
const tag = `v${version}`;
const notes = argVal('--notes', `Stream Timer ${tag}`);

function run(cmd, cwd = ROOT) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function getGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const res = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  for (const line of (res.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('password=')) return line.slice('password='.length).trim();
  }
  throw new Error('No GitHub token found in git credential manager or GITHUB_TOKEN');
}

// 1. Sync version across package.json, Cargo.toml, and tauri.conf.json
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const tauriConfPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = version;
fs.writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`, 'utf8');

const cargoPath = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const cargoRaw = fs.readFileSync(cargoPath, 'utf8').replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
fs.writeFileSync(cargoPath, cargoRaw, 'utf8');

// 2. Verify tests & build release binary
run('node tests/model.test.mjs');
run('node tests/engine.test.mjs');
run('cargo build --release', path.join(ROOT, 'src-tauri'));

const builtExe = path.join(ROOT, 'src-tauri', 'target', 'release', 'stream-timer-desktop.exe');
const rootExe = path.join(ROOT, 'Stream Timer.exe');
fs.copyFileSync(builtExe, rootExe);

// 3. Generate SHA-256 verified latest.json
const dlUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/Stream-Timer.exe`;
run(`node scripts/build-release-manifest.mjs --version "${version}" --url "${dlUrl}" --notes "${notes.replace(/"/g, '\\"')}"`);

// 4. Commit, tag & push to GitHub
run('git add -A');
try { run(`git commit -m "Release ${tag}"`); } catch { console.log('Nothing new to commit.'); }
try { run(`git tag -f ${tag}`); } catch { /* ignore */ }
run('git push origin main');
run(`git push -f origin ${tag}`);

// 5. Create or update GitHub Release and upload Stream-Timer.exe + latest.json
const token = getGitHubToken();
const ghHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'StreamTimerPublisher',
};

let release;
const existingRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`, { headers: ghHeaders });
if (existingRes.ok) {
  release = await existingRes.json();
} else {
  const createRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { ...ghHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `Stream Timer ${tag}`, body: notes, draft: false, prerelease: false }),
  });
  if (!createRes.ok) throw new Error(`Create release failed: ${createRes.status} ${await createRes.text()}`);
  release = await createRes.json();
}

const uploadBase = release.upload_url.replace(/\{[^}]+\}$/, '');
for (const asset of [
  { name: 'Stream-Timer.exe', file: rootExe, type: 'application/octet-stream' },
  { name: 'latest.json', file: path.join(ROOT, 'latest.json'), type: 'application/json' },
]) {
  const prev = (release.assets || []).find((a) => a.name === asset.name);
  if (prev) {
    await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${prev.id}`, { method: 'DELETE', headers: ghHeaders });
  }
  const bytes = fs.readFileSync(asset.file);
  const up = await fetch(`${uploadBase}?name=${encodeURIComponent(asset.name)}`, {
    method: 'POST',
    headers: { ...ghHeaders, 'content-type': asset.type, 'content-length': String(bytes.length) },
    body: bytes,
  });
  if (!up.ok) throw new Error(`Upload ${asset.name} failed: ${up.status} ${await up.text()}`);
  console.log(`Uploaded ${asset.name} (${bytes.length} bytes)`);
}

console.log(`\nPublished live release: ${release.html_url}`);
