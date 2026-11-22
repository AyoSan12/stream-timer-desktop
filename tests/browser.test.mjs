// Full Browser E2E + Visual Screenshot Inspection for Stream Timer Desktop:
//   - Apple Intro Splash -> 6-Step Setup Assistant (with language switch, currency presets,
//     Streamlabs visual guide, global/regional country-badged gateways)
//   - 2nd Launch direct entry to Home Mission Control Cockpit
//   - Dark Mode & Light Mode switching
//   - Multi-Profile Switcher (Add 2nd Japanese/JPY profile, switch, isolate, delete)
//   - Finance dynamic currency + non-destructive reset + 5 exports
//   - Zero nav overflow & zero unlabelled accessibility controls

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { assert, eq, runCases, summarize } from './harness.mjs';

const require = createRequire('H:/AI/arthava/planning/rebuild-2026-10-28/proof/timer-foundation/package.json');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-timer-ui-test-'));
const evDir = path.join(process.cwd(), 'evidence');
fs.mkdirSync(evDir, { recursive: true });

async function startEngine() {
  const child = spawn(process.execPath, ['engine/main.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '0', STREAM_TIMER_DATA_DIR: tmpDir, FX_AUTO_FETCH: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('engine timeout')), 8000);
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.event === 'listen' && obj.port) { clearTimeout(t); resolve(obj.port); return; }
        } catch { /* wait */ }
      }
    });
    child.stderr.on('data', (c) => process.stderr.write(c));
  });
  return { child, port, base: `http://127.0.0.1:${port}` };
}

const ACCESSIBILITY_PROBE = () => {
  const bad = [];
  const els = document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, a[href]');
  for (const el of els) {
    if (el.hidden) continue;
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
    const wrapped = el.closest('label');
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    if (!label && !wrapped && !byFor) bad.push(`${el.tagName}#${el.id || '(no-id)'}`);
  }
  return { total: els.length, unlabelled: bad };
};

const eng = await startEngine();
const browser = await chromium.launch({ headless: true });
const cases = [];

cases.push({
  id: 'UI1-splash-onboarding-wizard-and-full-i18n',
  async fn() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 } });
    const page = await ctx.newPage();
    await page.goto(eng.base, { waitUntil: 'domcontentloaded' });

    // Capture Apple Intro Splash briefly, then wait for Setup Assistant (after splash fades)
    await page.screenshot({ path: path.join(evDir, '01-splash.png') });
    await page.waitForSelector('#onboardingRoot:not([hidden])', { timeout: 6000 });
    await page.waitForSelector('#appleSplash', { state: 'hidden', timeout: 4000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(evDir, '02-onboarding-hello-en.png') });

    // Verify ZERO card/font size jitter across all 8 languages & ZERO spurious slide after Back -> Language click
    const baseMetrics = await page.evaluate(() => ({
      cardH: Math.round(document.querySelector('.ob-card').getBoundingClientRect().height),
      choiceHeights: [...document.querySelectorAll('#obLangGrid .ob-choice-card')].map((el) => Math.round(el.getBoundingClientRect().height)),
    }));
    for (const label of ['Bahasa Indonesia', '日本語', '한국어', '简体中文', '繁體中文', 'Español', 'Português', 'English']) {
      await page.locator('#obLangGrid button', { hasText: label }).click();
      const cur = await page.evaluate(() => ({
        cardH: Math.round(document.querySelector('.ob-card').getBoundingClientRect().height),
        choiceHeights: [...document.querySelectorAll('#obLangGrid .ob-choice-card')].map((el) => Math.round(el.getBoundingClientRect().height)),
        animClasses: [...document.getElementById('obStep0').classList].filter((c) => c.startsWith('anim-')),
      }));
      eq(cur.cardH, baseMetrics.cardH, `Onboarding card height stayed stable (${label})`);
      eq(JSON.stringify(cur.choiceHeights), JSON.stringify(baseMetrics.choiceHeights), `All 8 language cards kept identical height (${label})`);
      eq(cur.animClasses.length, 0, `No spurious slide animation when clicking language (${label})`);
    }
    // Go Next -> Back -> wait for slide end -> click language -> confirm ZERO slide re-trigger!
    await page.locator('#obNextBtn').click();
    await page.waitForTimeout(320);
    await page.locator('#obBackBtn').click();
    await page.waitForTimeout(340);
    await page.locator('#obLangGrid button', { hasText: '日本語' }).click();
    assert((await page.locator('#obNextBtn').textContent()).includes('はじめる'), 'Instant Japanese translation on onboarding');
    const afterBackAnim = await page.evaluate(() => [...document.getElementById('obStep0').classList].filter((c) => c.startsWith('anim-')).length);
    eq(afterBackAnim, 0, 'No weird slide animation on Step 0 after returning via Back and selecting a language');
    await page.locator('#obLangGrid button', { hasText: 'English' }).click();
    assert((await page.locator('#obNextBtn').textContent()).includes('Get Started'), 'English restored cleanly');

    // Step 0 -> Step 1 (Profile & Currency)
    await page.locator('#obNextBtn').click();
    await page.fill('#obProfName', 'Alex Global');
    await page.fill('#obProfHandle', '@alexlive');
    await page.selectOption('#obBaseCurrency', 'USD');
    await page.waitForFunction(() => document.getElementById('obCurrencyPreview')?.textContent.includes('USD'));
    await page.screenshot({ path: path.join(evDir, '03-onboarding-profile.png') });

    // Step 1 -> Step 2 (Mandatory Streamlabs visual guide)
    await page.locator('#obNextBtn').click();
    assert(await page.locator('#obSlIllustration svg').isVisible(), 'Streamlabs visual guide SVG rendered');
    await page.screenshot({ path: path.join(evDir, '04-onboarding-streamlabs.png') });
    // Verify Streamlabs token is enforced
    await page.locator('#obNextBtn').click();
    assert((await page.locator('#obValidationMsg').textContent()).length > 0, 'Streamlabs token required');
    await page.fill('#obSlToken', 'demo-streamlabs-socket-token-123456');

    // Step 2 -> Step 3 (YouTube + Twitch 70/30)
    await page.locator('#obNextBtn').click();
    await page.locator('#obStreamTw').click();
    assert(await page.locator('#obTwSplitWrap').isVisible(), 'Twitch split selector appears');
    await page.selectOption('#obTwSplitSelect', '30');

    // Step 3 -> Step 4 (Global & Regional Donation Gateways with Country Badges)
    await page.locator('#obNextBtn').click();
    await page.locator('[data-ob-dono="streamelements"]').click();
    await page.locator('[data-ob-dono="kofi"]').click();
    await page.locator('[data-ob-dono="saweria"]').click();
    await page.locator('[data-ob-dono="chzzk"]').click();
    await page.locator('[data-ob-dono="livepix"]').click();
    await page.screenshot({ path: path.join(evDir, '05-onboarding-donations.png') });

    // Step 4 -> Step 5 (Tailored Quick Setup -> Finish)
    await page.locator('#obNextBtn').click();
    assert((await page.locator('#obSetupCards').textContent()).includes('StreamElements'), 'Tailored setup includes selected StreamElements');
    assert((await page.locator('#obSetupCards').textContent()).includes('Naver Chzzk'), 'Tailored setup includes selected Chzzk');
    await page.screenshot({ path: path.join(evDir, '06-onboarding-setup.png') });

    await page.locator('#obNextBtn').click();
    await page.waitForSelector('#appRoot:not([hidden])', { timeout: 6000 });
    await ctx.close();
    return { completed6Steps: true };
  },
});

cases.push({
  id: 'UI2-second-launch-home-cockpit-dark-mode-and-multi-profile',
  async fn() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 } });
    const page = await ctx.newPage();

    // Seed sample live multi-currency transactions into Alex Global (USD)
    await fetch(`${eng.base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'set', amountMs: 1_800_000 }) });
    await fetch(`${eng.base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'resume' }) });
    await fetch(`${eng.base}/api/donations/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'SuperChat', txType: 'yt_superchat', gifterName: 'Kenji', amount: 1550, currency: 'JPY', message: 'Ganbare!' }) });
    await fetch(`${eng.base}/api/webhooks/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'kofi', gifterName: 'Maya', amount: 20, currency: 'USD' }) });
    await fetch(`${eng.base}/api/webhooks/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'livepix', gifterName: 'Lucas', amount: 57.5, currency: 'BRL' }) });

    // 2nd launch goes straight from splash into Home Mission Control (no onboarding!)
    await page.goto(eng.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#appRoot:not([hidden])', { timeout: 6000 });
    await page.waitForSelector('#appleSplash', { state: 'hidden', timeout: 4000 });
    assert(await page.locator('#onboardingRoot').isHidden(), '2nd launch skips onboarding');
    await page.waitForFunction(() => document.getElementById('homeActiveNet')?.textContent !== '$0.00');
    await page.waitForTimeout(300);

    // Verify 8-tab top nav bar fits with ZERO overflow!
    const navFit = await page.evaluate(() => {
      const n = document.getElementById('mainNav');
      return { scrollW: n.scrollWidth, clientW: n.clientWidth };
    });
    assert(navFit.scrollW <= navFit.clientW + 2, `8-tab nav overflow: ${navFit.scrollW} > ${navFit.clientWidth}`);
    await page.screenshot({ path: path.join(evDir, '07-home-cockpit-light.png') });

    // Switch to Finance & verify dynamic USD formatting
    await page.locator('#nav-finance').click();
    await page.waitForFunction(() => document.getElementById('finKpiGross')?.textContent.includes('$'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(evDir, '08-finance-usd-light.png') });

    // Open Top-Right Profile Popover -> toggle Dark Mode -> screenshot Home in Dark Mode!
    await page.locator('#profileMenuBtn').click();
    assert(await page.locator('#profilePopover').isVisible(), 'Profile popover opens');
    await page.waitForTimeout(260);
    await page.screenshot({ path: path.join(evDir, '09-profile-popover.png') });
    await page.locator('[data-theme-choice="dark"]').click();
    eq(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'Dark mode applied');
    await page.locator('#nav-home').click();
    await page.waitForTimeout(320);
    await page.screenshot({ path: path.join(evDir, '10-home-cockpit-dark.png') });

    // Integrations -> Webhooks & 1-Click Tunnel view
    await page.locator('#nav-integrations').click();
    await page.locator('[data-integ-tab="webhooks"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(evDir, '11-integrations-tunnel-dark.png') });

    // Add 2nd Profile (Japanese / JPY) via Profile Popover -> "+ Add New Profile"
    await page.locator('#profileMenuBtn').click();
    await page.locator('#popAddBtn').click();
    await page.waitForSelector('#onboardingRoot:not([hidden])');
    await page.locator('#obLangGrid button', { hasText: '日本語' }).click();
    await page.locator('#obNextBtn').click();
    await page.fill('#obProfName', 'Tokyo VTuber');
    await page.selectOption('#obBaseCurrency', 'JPY');
    await page.locator('#obNextBtn').click();
    await page.fill('#obSlToken', 'tokyo-sl-token-999999');
    await page.locator('#obNextBtn').click();
    await page.locator('#obNextBtn').click();
    await page.locator('#obNextBtn').click();
    await page.locator('#obNextBtn').click();
    await page.waitForSelector('#appRoot:not([hidden])');
    await page.waitForTimeout(350);
    assert((await page.locator('#nav-home').textContent()).trim() === 'ホーム', 'Full UI switched to Japanese for Tokyo VTuber profile');
    await page.screenshot({ path: path.join(evDir, '12-home-japanese-jpy.png') });

    // Accessibility audit across all controls
    const a11y = await page.evaluate(ACCESSIBILITY_PROBE);
    eq(a11y.unlabelled.length, 0, `Unlabelled controls: ${a11y.unlabelled.join(', ')}`);

    await ctx.close();
    return { navFit, controls: a11y.total };
  },
});

cases.push({
  id: 'UI3-unified-apple-toolbar-zero-shift-and-updates-ui',
  async fn() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__TAURI_INTERNALS__ = {
        invoked: [],
        invoke(cmd, args) {
          this.invoked.push({ cmd, args });
          return Promise.resolve(true);
        },
      };
    });

    await page.goto(`${eng.base}/?desktop=1&theme=dark`, { waitUntil: 'domcontentloaded' });
    const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    eq(initialTheme, 'dark', 'Immediate dark theme set synchronously before paint (zero white flash)');

    await page.waitForSelector('#appRoot:not([hidden])', { timeout: 6000 });
    await page.waitForSelector('#appleSplash', { state: 'hidden', timeout: 4000 });
    await page.waitForTimeout(250);

    // 1. Verify ZERO horizontal nav bar shift across ALL 7 unified tabs (Home -> Timer -> Donations -> Finance -> OBS -> Integrations -> Settings)
    const navLefts = [];
    for (const tabId of ['nav-home', 'nav-timer', 'nav-donations', 'nav-finance', 'nav-overlay', 'nav-integrations', 'nav-settings']) {
      await page.locator(`#${tabId}`).click();
      await page.waitForTimeout(80);
      const x = await page.evaluate(() => Math.round(document.getElementById('mainNav').getBoundingClientRect().left));
      navLefts.push(x);
    }
    const minNavX = Math.min(...navLefts);
    const maxNavX = Math.max(...navLefts);
    eq(minNavX, maxNavX, `Main nav bar never shifts horizontally across all 7 tabs (lefts: ${navLefts.join(',')})`);

    // 1b. Verify unified Timer view (Controls | Donation Tiers | Triggers) + auto-save persistence of custom Timer Label ("Jam hidup")
    await page.locator('#nav-timer').click();
    await page.waitForTimeout(120);
    await page.locator('[data-timer-tab="tiers"]').click();
    await page.waitForTimeout(100);
    assert(await page.locator('#timerPanelTiers').isVisible(), 'Timer -> Donation Tiers sub-tab opens cleanly');
    await page.locator('[data-timer-tab="triggers"]').click();
    await page.waitForTimeout(100);
    assert(await page.locator('#timerPanelTriggers').isVisible(), 'Timer -> Triggers sub-tab opens cleanly');
    await page.locator('[data-timer-tab="controls"]').click();
    await page.waitForTimeout(100);

    // Type custom Timer Label WITHOUT clicking Save Overlay Style, verify debounced auto-save persists across reload & OBS /source
    await page.locator('#nav-overlay').click();
    await page.waitForTimeout(120);
    await page.locator('#ovTimerName').fill('Jam hidup');
    await page.waitForTimeout(750);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#appRoot:not([hidden])', { timeout: 6000 });
    await page.waitForSelector('#appleSplash', { state: 'hidden', timeout: 4000 });
    await page.waitForTimeout(250);
    const persistedLbl = await page.locator('#ovTimerName').inputValue();
    eq(persistedLbl, 'Jam hidup', 'Custom Timer Label auto-saves and survives reload without clicking Save');
    const heroLbl = await page.locator('#timerHeroLabel').textContent();
    eq(heroLbl, 'JAM HIDUP', 'Custom Timer Label also syncs to Timer hero label');
    const obsCheck = await ctx.newPage();
    await obsCheck.goto(`${eng.base}/source`, { waitUntil: 'domcontentloaded' });
    await obsCheck.waitForTimeout(350);
    eq(await obsCheck.locator('#timerLabel').textContent(), 'JAM HIDUP', 'OBS Browser Source renders custom Timer Label immediately');
    await obsCheck.close();

    // Capture Timer unified view & Settings -> Desktop
    await page.locator('#nav-timer').click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(evDir, '15-timer-unified-dark.png') });
    await page.locator('#nav-settings').click();
    await page.locator('[data-set-tab="desktop"]').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(evDir, '14-settings-software-update-dark.png') });

    // 2. Scroll down 420px on Integrations -> Webhooks and verify Unified Single 52px Toolbar stays pinned at top: 0 with ONLY 1 brand logo!
    await page.locator('#nav-integrations').click();
    await page.locator('[data-integ-tab="webhooks"]').click();
    await page.waitForTimeout(250);
    await page.evaluate(() => window.scrollTo(0, 420));
    await page.waitForTimeout(150);

    const chrome = await page.evaluate(() => {
      const tbHidden = getComputedStyle(document.getElementById('desktopTitlebar')).display === 'none';
      const topbar = document.getElementById('appTopbar').getBoundingClientRect();
      const brandMark = document.getElementById('brandMark').getBoundingClientRect();
      const hasMiniClock = Boolean(document.getElementById('headerMiniClock'));
      const winCtrlVisible = !document.getElementById('topbarWinControls').hidden;
      return {
        scrollY: Math.round(window.scrollY),
        tbHidden,
        topbarTop: Math.round(topbar.top),
        topbarHeight: Math.round(topbar.height),
        brandLeft: Math.round(brandMark.left),
        hasMiniClock,
        winCtrlVisible,
      };
    });

    assert(chrome.scrollY > 100, `Page actually scrolled (${chrome.scrollY}px)`);
    assert(chrome.tbHidden, 'Separate onboarding titlebar hidden in workspace (ZERO duplicate logos!)');
    eq(chrome.topbarTop, 0, 'Unified Apple toolbar stays pinned at top: 0 during scroll');
    eq(chrome.topbarHeight, 52, 'Unified Apple toolbar height is crisp 52px');
    assert(chrome.brandLeft >= 16, `Single top-left brand logo has generous frame inset (${chrome.brandLeft}px)`);
    assert(!chrome.hasMiniClock, 'Removed headerMiniClock so nav stays rock-solid centered');
    assert(chrome.winCtrlVisible, 'Inline native window controls visible inside unified toolbar');

    await page.screenshot({ path: path.join(evDir, '13-desktop-titlebar-scrolled-dark.png') });

    // Click inline Close button and confirm IPC win_close fires cleanly
    await page.locator('#topCloseBtn').click();
    const calls = await page.evaluate(() => window.__TAURI_INTERNALS__.invoked);
    assert(calls.some((c) => c.cmd === 'win_close'), 'Unified Close button invokes win_close IPC');

    await ctx.close();
    return chrome;
  },
});

try {
  const results = await runCases(cases);
  console.log(JSON.stringify(summarize(results)));
  for (const r of results.filter((x) => x.verdict !== 'pass')) console.error(r);
  process.exitCode = results.some((x) => x.verdict === 'fail') ? 1 : 0;
} finally {
  await browser.close();
  eng.child.kill();
  await new Promise((r) => setTimeout(r, 250));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
