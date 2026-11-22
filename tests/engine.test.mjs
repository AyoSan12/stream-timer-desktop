// End-to-end SQLite WAL Engine + Multi-Profile + Dynamic Base Currency + Global
// Webhooks + Finance Sessions + .stbackup Export/Import verification.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { assert, eq, runCases, summarize } from './harness.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-timer-desktop-test-'));

async function startEngine() {
  const child = spawn(process.execPath, ['engine/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '0',
      STREAM_TIMER_DATA_DIR: tmpDir,
      FX_AUTO_FETCH: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('engine startup timeout')), 8000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.event === 'listen' && obj.port) {
            clearTimeout(timer);
            resolve(obj.port);
            return;
          }
        } catch { /* wait */ }
      }
    });
    child.stderr.on('data', (c) => process.stderr.write(c));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`engine exited early: ${code}`)); });
  });

  return { child, port, base: `http://127.0.0.1:${port}` };
}

async function req(base, p, { method = 'GET', body = null, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== null) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${p}`, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, data };
}

const eng = await startEngine();
const cases = [];

cases.push({
  id: 'E1-fresh-install-requires-onboarding',
  async fn() {
    const boot = await req(eng.base, '/api/app/bootstrap');
    eq(boot.status, 200, 'bootstrap returns 200');
    eq(boot.data.needsOnboarding, true, 'fresh app requires onboarding');
    eq(boot.data.profiles.length, 0, 'zero profiles on first launch');
    assert(boot.data.platforms.length >= 15, 'returns full global donation platform catalog');
    return { platforms: boot.data.platforms.length };
  },
});

let profUsdId = null;
let profJpyId = null;

cases.push({
  id: 'E2-create-multi-profiles-with-different-languages-and-currencies',
  async fn() {
    // Profile 1: English / USD / YouTube + Twitch / Streamlabs + Ko-fi + Chzzk
    const p1 = await req(eng.base, '/api/profiles', {
      method: 'POST',
      body: {
        name: 'Global Main',
        language: 'en',
        baseCurrency: 'USD',
        streamPlatforms: ['youtube', 'twitch'],
        donationPlatforms: ['streamlabs', 'streamelements', 'kofi', 'chzzk'],
        twitchSplitCutPct: 30,
      },
    });
    eq(p1.status, 200, 'USD profile created');
    profUsdId = p1.data.profile.id;
    eq(p1.data.app.needsOnboarding, false, 'onboarding complete');

    // Add timer + manual USD Super Chat + Ko-fi webhook test
    await req(eng.base, '/api/command', { method: 'POST', body: { type: 'set', amountMs: 600_000 } });
    await req(eng.base, '/api/command', { method: 'POST', body: { type: 'resume' } });
    const sc = await req(eng.base, '/api/donations/manual', {
      method: 'POST',
      body: { provider: 'SuperChat', txType: 'yt_superchat', gifterName: 'Alice', amount: 20, currency: 'USD', message: 'Hello!' },
    });
    eq(sc.status, 200, 'USD Super Chat recorded');
    eq(sc.data.grossAmount, 20, 'gross = $20');
    eq(sc.data.creditMs, 3_600_000, '$20 hits $10 USD tier (1h)');

    const kofi = await req(eng.base, '/api/webhooks/test', {
      method: 'POST',
      body: { provider: 'kofi', gifterName: 'Bob', amount: 15, currency: 'USD' },
    });
    eq(kofi.status, 200, 'Ko-fi webhook test succeeded');

    // Profile 2: Japanese / JPY / YouTube / Streamlabs + Doneru
    const p2 = await req(eng.base, '/api/profiles', {
      method: 'POST',
      body: {
        name: 'JP VTuber',
        language: 'ja',
        baseCurrency: 'JPY',
        streamPlatforms: ['youtube'],
        donationPlatforms: ['streamlabs', 'doneru'],
      },
    });
    eq(p2.status, 200, 'JPY profile created');
    profJpyId = p2.data.profile.id;

    // Verify complete isolation: JPY profile has 0 donations & paused 0ms timer!
    const jpyHist = await req(eng.base, '/api/donations');
    eq(jpyHist.data.baseCurrency, 'JPY', 'active profile is JPY');
    eq(jpyHist.data.donations.length, 0, 'JPY profile isolated with 0 donations');

    // Switch back to USD profile -> verify its 2 donations & running timer are intact!
    const sw = await req(eng.base, '/api/profiles/switch', { method: 'POST', body: { profileId: profUsdId } });
    eq(sw.status, 200, 'switched back to USD profile');
    const usdHist = await req(eng.base, '/api/donations');
    eq(usdHist.data.donations.length, 2, 'USD profile retains both donations');
    return { profUsdId, profJpyId };
  },
});

cases.push({
  id: 'E3-finance-non-destructive-reset-exports-and-home-cockpit',
  async fn() {
    // Check Home Cockpit summary
    const home = await req(eng.base, '/api/home');
    eq(home.status, 200, 'Home API returns 200');
    eq(home.data.activeIncome.grossAmount, 35, 'Active cycle gross = $35');
    eq(home.data.recentDonations.length, 2, 'Home lists 2 recent donations');

    // Non-destructive Finance Reset
    const rst = await req(eng.base, '/api/finance/sessions/reset', {
      method: 'POST',
      body: { closingLabel: 'Stream Day 1', nextLabel: 'Stream Day 2' },
    });
    eq(rst.status, 200, 'finance session reset succeeded');

    const curFin = await req(eng.base, '/api/finance/report?session=current');
    eq(curFin.data.summary.grossAmount, 0, 'Day 2 starts at $0');
    const day1Fin = await req(eng.base, '/api/finance/report?session=session-1');
    eq(day1Fin.data.summary.grossAmount, 35, 'Day 1 preserves all $35');

    // Verify all 5 export formats over HTTP
    for (const fmt of ['xlsx', 'csv', 'json', 'md', 'html']) {
      const exp = await req(eng.base, `/api/finance/export?session=all&format=${fmt}`);
      eq(exp.status, 200, `export ${fmt} returns 200`);
    }
    return { day1Net: day1Fin.data.summary.netAmount };
  },
});

cases.push({
  id: 'E4-profile-backup-import-and-delete',
  async fn() {
    // Export .stbackup for USD profile
    const bak = await req(eng.base, `/api/profiles/${profUsdId}/backup`);
    eq(bak.status, 200, 'backup downloaded');
    eq(bak.data.format, 'stream-timer-backup-v1', 'valid backup bundle format');
    eq(bak.data.tables.donation_event.length, 2, 'backup includes all 2 donation events');

    // Import as a fresh 3rd profile
    const imp = await req(eng.base, '/api/profiles/import', { method: 'POST', body: bak.data });
    eq(imp.status, 200, 'backup imported as new profile');
    const impHist = await req(eng.base, '/api/donations');
    eq(impHist.data.donations.length, 2, 'imported profile restored all 2 donations');

    // Delete imported profile cleanly
    const del = await req(eng.base, `/api/profiles/${imp.data.profile.id}`, { method: 'DELETE' });
    eq(del.status, 200, 'deleted imported profile');
    eq(del.data.app.profiles.length, 2, '2 original profiles remain');
    return { backupTx: 2, remainingProfiles: 2 };
  },
});

cases.push({
  id: 'E5-desktop-hotkey-and-tray-commands',
  async fn() {
    const add1 = await req(eng.base, '/api/command', { method: 'POST', body: { type: 'add', amountMs: 60000 } });
    eq(add1.status, 200, 'hotkey add +1m succeeded');
    const t1 = await req(eng.base, '/api/command/toggle', { method: 'POST', body: {} });
    eq(t1.status, 200, 'hotkey toggle 1 succeeded');
    const firstState = t1.data.state;
    const t2 = await req(eng.base, '/api/command/toggle', { method: 'POST', body: {} });
    eq(t2.status, 200, 'hotkey toggle 2 succeeded');
    assert(t2.data.state !== firstState, `state toggled (${firstState} -> ${t2.data.state})`);
    return { firstState, secondState: t2.data.state };
  },
});

cases.push({
  id: 'E6-builtin-software-updater-sha256-and-preupdate-backup',
  async fn() {
    // Stage a mock new binary + valid latest.json manifest in tmpDir
    const fakeBinPath = path.join(tmpDir, 'StreamTimer-v1.1.0-mock.exe');
    const fakeBytes = Buffer.from('MZ-STREAM-TIMER-MOCK-V1.1.0-BINARY');
    fs.writeFileSync(fakeBinPath, fakeBytes);
    const sha256 = crypto.createHash('sha256').update(fakeBytes).digest('hex');

    const manifestPath = path.join(tmpDir, 'latest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: '1.1.0',
      publishedAt: '2026-11-23T00:00:00Z',
      notes: 'Unified Apple toolbar & 15 audited donation platforms.',
      windows: { url: pathToFileURL(fakeBinPath).href, sha256 },
    }));

    const chk = await req(eng.base, '/api/updates/check', {
      method: 'POST',
      body: { feedUrl: pathToFileURL(manifestPath).href },
    });
    eq(chk.status, 200, 'update check returned 200');
    eq(chk.data.updates.status, 'update_available', 'detected newer semver v1.1.0');
    eq(chk.data.updates.latestVersion, '1.1.0', 'latestVersion = 1.1.0');

    // Download & stage (verifies SHA-256 + creates automatic pre-update .stbackup!)
    const dl = await req(eng.base, '/api/updates/download', { method: 'POST', body: {} });
    eq(dl.status, 200, 'verified update staged successfully');
    eq(dl.data.status.status, 'ready_to_install', 'status = ready_to_install');
    assert(fs.existsSync(dl.data.status.stagedPath), 'staged binary file exists on disk');
    assert(fs.existsSync(dl.data.status.backupDir), 'automatic pre-update backup folder created');
    const bakFiles = fs.readdirSync(dl.data.status.backupDir).filter((f) => f.endsWith('.stbackup'));
    assert(bakFiles.length >= 2, `auto-backed up all ${bakFiles.length} profiles before update`);

    // Verify tampered SHA-256 is strictly rejected!
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: '1.2.0',
      windows: { url: pathToFileURL(fakeBinPath).href, sha256: '0'.repeat(64) },
    }));
    await req(eng.base, '/api/updates/check', { method: 'POST', body: { feedUrl: pathToFileURL(manifestPath).href } });
    const badDl = await req(eng.base, '/api/updates/download', { method: 'POST', body: {} });
    eq(badDl.status, 400, 'tampered SHA-256 update strictly rejected (400)');
    return { staged: true, autoBackedUpProfiles: bakFiles.length };
  },
});

try {
  const results = await runCases(cases);
  console.log(JSON.stringify(summarize(results)));
  for (const r of results.filter((x) => x.verdict !== 'pass')) console.error(r);
  process.exitCode = results.some((x) => x.verdict === 'fail') ? 1 : 0;
} finally {
  eng.child.kill();
  await new Promise((r) => setTimeout(r, 250));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
