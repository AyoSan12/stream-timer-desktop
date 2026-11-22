// Stream Timer Desktop — Complete Apple UI Controller.
// Handles Intro Splash, 6-Step Setup Assistant, Multi-Profile Switcher,
// 8-Language Reactive i18n, Light/Dark/System Appearance, Sliding Nav Thumb,
// Home Mission Control, Timer, Donations, Finance, Rules, OBS, Integrations,
// 1-Click Tunnel, Settings, and Tauri v2 Desktop IPC hooks.

import { remainingAt, formatSeconds, formatClock } from './timer-client.js';
import { createTimerLink } from './timer-link.js';
import { APP_MARK_SVG, STREAMLABS_GUIDE_SVG, OBS_GUIDE_SVG } from './illustrations.js';
import {
  LANGUAGE_META, setLanguage, getLanguage, setBaseCurrency, getCurrency,
  t, applyDomTranslations, fmtMoney, fmtDateTime,
} from '../i18n/index.js';

const $ = (id) => document.getElementById(id);

const POPULAR_CURRENCIES = [
  ['USD', 'USD ($) — US Dollar'],
  ['IDR', 'IDR (Rp) — Indonesian Rupiah'],
  ['JPY', 'JPY (¥) — Japanese Yen'],
  ['KRW', 'KRW (₩) — South Korean Won'],
  ['TWD', 'TWD (NT$) — New Taiwan Dollar'],
  ['SGD', 'SGD (S$) — Singapore Dollar'],
  ['MYR', 'MYR (RM) — Malaysian Ringgit'],
  ['EUR', 'EUR (€) — Euro'],
  ['GBP', 'GBP (£) — British Pound'],
  ['BRL', 'BRL (R$) — Brazilian Real'],
  ['AUD', 'AUD (A$) — Australian Dollar'],
  ['CAD', 'CAD (C$) — Canadian Dollar'],
  ['PHP', 'PHP (₱) — Philippine Peso'],
  ['THB', 'THB (฿) — Thai Baht'],
  ['VND', 'VND (₫) — Vietnamese Dong'],
  ['CNY', 'CNY (¥) — Chinese Yuan'],
  ['HKD', 'HKD (HK$) — Hong Kong Dollar'],
  ['MXN', 'MXN (MX$) — Mexican Peso'],
  ['INR', 'INR (₹) — Indian Rupee'],
  ['CHF', 'CHF (Fr) — Swiss Franc'],
];

const AVATAR_COLORS = ['#0071e3', '#1d1d1f', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#0a84ff', '#5856d6'];

// -------------------------------------------------- App State ---------------

let bootData = null;
let activeProfile = null;
let snapshot = null;
let rulesData = null;
let draftRules = null;
let overlayCfg = { timerName: 'Stream Timer', totalName: 'Total Added', showTotal: true, bgMode: 'dark', position: 'bottom-left', fontSize: 38, opacity: 92, popup: true, rushOn: false, rushLv: 1 };
let donations = [];
let donoSelectMode = false;
const donoSelected = new Set();
let finData = null;
let finScope = 'current';
let finExportScopeOverride = null;
let finExportFromLedger = false;
let finInspectEventId = '';
let activeView = 'home';
let obsRevealed = false;
let toastTimer = null;
let helloTimer = null;
let link = null;
let rAFStarted = false;

// Onboarding wizard state
let obStep = 0;
let obIsAddingAnother = false;
const obState = {
  language: 'en',
  name: '',
  handle: '',
  baseCurrency: 'USD',
  avatarColor: '#0071e3',
  streamlabsToken: '',
  streamlabsVerified: false,
  streamPlatforms: new Set(['youtube']),
  twitchSplitCutPct: 50,
  donationPlatforms: new Set(['streamlabs']),
  extraCreds: {},
  draftWebhookToken: '',
};

// -------------------------------------------------- Helpers -----------------

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  el.classList.add('toast-visible');
  toastTimer = setTimeout(() => { toastTimer = null; el.classList.remove('toast-visible'); }, 3200);
}

async function api(url, { method = 'GET', body = null } = {}) {
  const init = { method, headers: { accept: 'application/json' }, cache: 'no-store' };
  if (body !== null) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  return { ok: res.ok, status: res.status, data, res };
}

function fmtDuration(ms) {
  const sec = Math.round((Number(ms) || 0) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', s ? `${s}s` : ''].filter(Boolean).join(' ') || '0s';
}

async function copyText(text, okMsg = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    showToast(okMsg);
  }
}

function applyAppearance(mode = 'system', animate = false) {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  try { localStorage.setItem('st_appearance', mode); } catch { /* ignore */ }
  if (animate) {
    document.documentElement.classList.add('theme-switching');
    setTimeout(() => document.documentElement.classList.remove('theme-switching'), 260);
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelectorAll('[data-theme-choice]').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeChoice === mode);
  });
  if (window.__TAURI_INTERNALS__?.invoke) {
    window.__TAURI_INTERNALS__.invoke('set_window_theme', { dark }).catch(() => {});
  }
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (bootData?.appearance === 'system') applyAppearance('system');
});

function populateCurrencySelect(sel, defaultCode = 'USD', includeExtraFx = true) {
  const prev = sel.value || defaultCode;
  sel.replaceChildren();
  const popSet = new Set(POPULAR_CURRENCIES.map(([c]) => c));
  const grp1 = document.createElement('optgroup');
  grp1.label = 'Popular Currencies';
  for (const [code, label] of POPULAR_CURRENCIES) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = label;
    grp1.append(o);
  }
  sel.append(grp1);
  if (includeExtraFx && bootData?.fx?.ratesPerUsd) {
    const extra = Object.keys(bootData.fx.ratesPerUsd).filter((c) => !popSet.has(c)).sort();
    if (extra.length) {
      const grp2 = document.createElement('optgroup');
      grp2.label = 'All 166 Supported Currencies';
      for (const c of extra) {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        grp2.append(o);
      }
      sel.append(grp2);
    }
  }
  sel.value = prev;
  if (!sel.value) sel.value = defaultCode;
}

function populateLanguageSelect(sel, current = 'en') {
  sel.replaceChildren();
  for (const l of LANGUAGE_META) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = `${l.native} (${l.region})`;
    sel.append(o);
  }
  sel.value = current;
}

// -------------------------------------------------- Tauri Desktop Chrome ----

function initDesktopTitlebar() {
  const isTauri = Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
  if (!isTauri) return;
  document.body.classList.add('is-desktop');
  const bar = $('desktopTitlebar');
  bar.hidden = false;
  $('topbarWinControls').hidden = false;
  $('tbBrandIcon').innerHTML = APP_MARK_SVG;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke?.(cmd, args).catch(() => {});

  const wireControls = (trayId, minId, maxId, closeId) => {
    const tBtn = $(trayId);
    if (tBtn) tBtn.addEventListener('click', () => invoke('win_hide_to_tray'));
    $(minId).addEventListener('click', () => invoke('win_minimize'));
    $(maxId).addEventListener('click', () => invoke('win_toggle_maximize'));
    $(closeId).addEventListener('click', () => {
      const onboarding = !$('onboardingRoot').hidden;
      invoke('win_close', { onboarding });
    });
  };
  wireControls('tbTrayBtn', 'tbMinBtn', 'tbMaxBtn', 'tbCloseBtn');
  wireControls('topTrayBtn', 'topMinBtn', 'topMaxBtn', 'topCloseBtn');

  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.tb-controls')) return;
    if (e.detail === 2) invoke('win_toggle_maximize');
    else invoke('win_start_dragging');
  });

  // Unified macOS-style dragging & double-click maximize on empty area of #appTopbar
  $('appTopbar').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, nav, #profilePopover, .profile-pill-btn, .tb-controls')) return;
    if (e.detail === 2) invoke('win_toggle_maximize');
    else invoke('win_start_dragging');
  });
}

// -------------------------------------------------- Sliding Apple Nav Thumb -

function updateNavThumb(instant = false) {
  const nav = $('mainNav');
  const thumb = $('navThumb');
  const activeBtn = nav.querySelector('.nav-btn.active');
  if (!activeBtn || !thumb) return;
  if (instant) thumb.style.transition = 'none';
  thumb.style.width = `${activeBtn.offsetWidth}px`;
  thumb.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
  if (instant) {
    thumb.getBoundingClientRect();
    thumb.style.transition = '';
  }
}

window.addEventListener('resize', () => updateNavThumb(true));

function switchView(viewId) {
  activeView = viewId;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${viewId}`));
  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => {
    const on = b.dataset.view === viewId;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  updateNavThumb(false);
  window.scrollTo({ top: 0, behavior: 'instant' });

  if (viewId === 'home') loadHome();
  else if (viewId === 'donations') loadDonations();
  else if (viewId === 'finance') loadFinance();
  else if (viewId === 'integrations') loadIntegrations();
  else if (viewId === 'settings') renderFxRatesList();
}

// -------------------------------------------------- 6-Step Setup Assistant --

function startHelloCycle(startIdx = 0) {
  if (helloTimer) clearInterval(helloTimer);
  let idx = startIdx;
  const word = $('obHelloWord');
  helloTimer = setInterval(() => {
    if ($('onboardingRoot').hidden || obStep !== 0) return;
    idx = (idx + 1) % LANGUAGE_META.length;
    word.style.opacity = '0';
    word.style.transform = 'translateY(3px)';
    setTimeout(() => {
      if ($('onboardingRoot').hidden || obStep !== 0) return;
      word.textContent = LANGUAGE_META[idx].greeting;
      word.lang = LANGUAGE_META[idx].code;
      word.style.opacity = '1';
      word.style.transform = 'translateY(0)';
    }, 180);
  }, 2800);
}

function renderOnboardingLangCards() {
  const grid = $('obLangGrid');
  grid.replaceChildren();
  LANGUAGE_META.forEach((l, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.lang = l.code;
    btn.className = `ob-choice-card${obState.language === l.code ? ' is-selected' : ''}`;
    btn.innerHTML = `<strong>${l.native}</strong><span>${l.region} · ${l.greeting}</span>`;
    btn.addEventListener('click', () => {
      if (obState.language === l.code) return;
      obState.language = l.code;
      setLanguage(l.code);
      const word = $('obHelloWord');
      word.textContent = l.greeting;
      word.lang = l.code;
      word.style.opacity = '1';
      word.style.transform = 'translateY(0)';
      startHelloCycle(i);
      renderOnboardingLangCards();
      renderOnboardingStepChrome(null);
    });
    grid.append(btn);
  });
}

function renderOnboardingSwatches() {
  const box = $('obColorSwatches');
  box.replaceChildren();
  for (const hex of AVATAR_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ob-swatch${obState.avatarColor === hex ? ' is-selected' : ''}`;
    b.style.backgroundColor = hex;
    b.setAttribute('aria-label', `Accent color ${hex}`);
    b.addEventListener('click', () => {
      obState.avatarColor = hex;
      renderOnboardingSwatches();
    });
    box.append(b);
  }
}

async function updateOnboardingCurrencyPreview() {
  const cur = $('obBaseCurrency').value || 'USD';
  obState.baseCurrency = cur;
  const r = await api(`/api/currency-presets?currency=${encodeURIComponent(cur)}`);
  if (r.ok && r.data?.rules) {
    const tiers = r.data.rules.tiers.map((ti) => `${fmtMoney(ti.minimumAmount, cur, obState.language)} → +${fmtDuration(ti.creditMs)}`).join('   ·   ');
    $('obCurrencyPreview').textContent = `Smart Preset (${cur}):  ${tiers}`;
  }
}

function renderOnboardingDonationCatalog() {
  const root = $('obDonationCatalog');
  root.replaceChildren();
  const platforms = bootData?.platforms || [];
  const regions = bootData?.regions || [];
  for (const reg of regions) {
    const items = platforms.filter((p) => p.region === reg.id);
    if (!items.length) continue;
    const sec = document.createElement('div');
    const h = document.createElement('p');
    h.className = 'ob-region-title';
    h.textContent = reg.fallback;
    const grid = document.createElement('div');
    grid.className = 'ob-plat-grid';
    for (const p of items) {
      const sel = obState.donationPlatforms.has(p.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `ob-plat-card${sel ? ' is-selected' : ''}${p.mandatory ? ' is-locked' : ''}`;
      card.dataset.obDono = p.id;
      card.innerHTML = `
        <div class="ob-plat-head"><strong>${p.name}</strong><span class="ob-country-tag">${p.countryBadge}</span></div>
        <span class="ob-proto-tag">${p.protocolBadge}${p.mandatory ? ' · Required' : ''}</span>
      `;
      card.addEventListener('click', () => {
        if (p.mandatory) return;
        if (obState.donationPlatforms.has(p.id)) obState.donationPlatforms.delete(p.id);
        else obState.donationPlatforms.add(p.id);
        renderOnboardingDonationCatalog();
      });
      grid.append(card);
    }
    sec.append(h, grid);
    root.append(sec);
  }
}

function renderOnboardingStep5Setup() {
  const box = $('obSetupCards');
  box.replaceChildren();
  const extras = (bootData?.platforms || []).filter((p) => p.id !== 'streamlabs' && obState.donationPlatforms.has(p.id));
  if (extras.length === 0) {
    const p = document.createElement('div');
    p.className = 'ob-setup-card';
    p.innerHTML = '<strong>Streamlabs Socket API Configured</strong><span class="helper-text">No additional regional gateways selected. You can add StreamElements, Ko-fi, Saweria, Tako, Chzzk, LivePix, and more anytime inside Integrations.</span>';
    box.append(p);
    return;
  }

  const tunnel = bootData?.tunnel || { status: 'stopped', effectiveBaseUrl: location.origin };
  const hasPublicUrl = Boolean(tunnel.publicUrl);
  const needsWebhook = extras.some((p) => Boolean(p.endpointPath));
  const urlToken = obState.draftWebhookToken || bootData?.draftWebhookToken || '';

  if (needsWebhook) {
    const tCard = document.createElement('div');
    tCard.className = 'ob-setup-card';
    tCard.style.borderColor = hasPublicUrl ? 'var(--success)' : 'var(--accent)';
    tCard.innerHTML = `
      <div class="ob-plat-head">
        <strong>Public Webhook URL (Required for Webhook Platforms)</strong>
        <span class="pill ${hasPublicUrl ? 'pill-ok' : 'pill-warn'}">${hasPublicUrl ? 'Public HTTPS Active ✓' : 'Local Only — Start Tunnel'}</span>
      </div>
      <div class="helper-text">${hasPublicUrl
        ? `Your live public HTTPS address is ready: <code>${tunnel.publicUrl}</code>. Copy each platform's Webhook URL below and paste it into your creator dashboard.`
        : 'Webhook platforms (Tako.id, Saweria, SociaBuzz, Ko-fi, etc.) send events from the internet to your PC. Click below to generate a free instant Cloudflare HTTPS Webhook URL (or configure later in Integrations).'}</div>
      <div class="btn-row">
        <button id="obTunnelStartBtn" type="button" class="btn btn-primary btn-pill btn-sm">${hasPublicUrl ? 'Restart Tunnel' : 'Generate Public Webhook URL (Free)'}</button>
        <input id="obTunnelCustomIn" type="url" placeholder="Or paste custom https:// domain…" value="${tunnel.customUrl || ''}" aria-label="Custom public HTTPS domain" style="flex:1;min-width:180px;height:31px;padding:0 10px;border-radius:9px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font-size:12px;">
        <button id="obTunnelCustomBtn" type="button" class="btn btn-pill btn-sm">Use URL</button>
      </div>
    `;
    tCard.querySelector('#obTunnelStartBtn').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Starting Cloudflare Tunnel…';
      const r = await api('/api/tunnel/start', { method: 'POST' });
      if (r.ok && bootData) bootData.tunnel = r.data;
      showToast(r.data?.publicUrl ? `Public Webhook URL live!` : (r.data?.lastError || 'Could not start tunnel'));
      await renderOnboardingStep5Setup();
    });
    tCard.querySelector('#obTunnelCustomBtn').addEventListener('click', async () => {
      const val = tCard.querySelector('#obTunnelCustomIn').value.trim();
      const r = await api('/api/tunnel/custom', { method: 'POST', body: { url: val } });
      if (r.ok && bootData) bootData.tunnel = r.data;
      showToast(r.data?.publicUrl ? 'Updated public webhook domain' : 'Cleared custom URL');
      await renderOnboardingStep5Setup();
    });
    box.append(tCard);
  }

  for (const plat of extras) {
    const card = document.createElement('div');
    card.className = 'ob-setup-card';
    const stepsHtml = plat.guideSteps.map((s) => `<div>• ${s}</div>`).join('');
    const fullWebhookUrl = plat.endpointPath
      ? `${tunnel.effectiveBaseUrl}${plat.endpointPath}${urlToken ? `/${urlToken}` : ''}`
      : '';

    card.innerHTML = `
      <div class="ob-plat-head">
        <strong>${plat.name}</strong>
        <div class="btn-row"><span class="ob-country-tag">${plat.countryBadge}</span><span class="pill">${plat.protocolBadge}</span></div>
      </div>
      <div class="helper-text">${stepsHtml}</div>
    `;

    if (fullWebhookUrl) {
      const urlBlock = document.createElement('div');
      urlBlock.className = 'stack-sm';
      urlBlock.innerHTML = `
        <div class="btn-row" style="justify-content:space-between;">
          <span style="font-size:12px;font-weight:600;color:var(--fg-2);">Webhook URL (Paste into ${plat.name})</span>
          <button type="button" class="btn btn-sm btn-pill" data-ob-copy="${fullWebhookUrl}">Copy Webhook URL</button>
        </div>
        <div class="mono-box">${fullWebhookUrl}</div>
      `;
      urlBlock.querySelector('[data-ob-copy]').addEventListener('click', () => {
        copyText(fullWebhookUrl, `Copied ${plat.name} Webhook URL`);
      });
      card.append(urlBlock);
    }

    for (const f of plat.credentialFields || []) {
      const lbl = document.createElement('label');
      lbl.className = 'field';
      lbl.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = f.type || 'text';
      inp.placeholder = f.placeholder || '';
      inp.value = obState.extraCreds[plat.id]?.[f.key] || '';
      inp.addEventListener('input', () => {
        if (!obState.extraCreds[plat.id]) obState.extraCreds[plat.id] = { enabled: true };
        obState.extraCreds[plat.id][f.key] = inp.value.trim();
      });
      lbl.append(inp);
      card.append(lbl);
    }
    box.append(card);
  }
}

function renderOnboardingStepChrome(animateDir = null) {
  const dots = $('obDots');
  dots.replaceChildren();
  for (let i = 0; i < 6; i += 1) {
    const d = document.createElement('span');
    d.className = `ob-dot${i === obStep ? ' is-active' : (i < obStep ? ' is-done' : '')}`;
    dots.append(d);
  }
  const stepNames = [t('ob.step.lang'), t('ob.step.profile'), t('ob.step.streamlabs'), t('ob.step.platforms'), t('ob.step.donations'), t('ob.step.setup')];
  $('obStepTag').textContent = `${obStep + 1} / 6 · ${stepNames[obStep]}`;
  $('obBackBtn').hidden = obStep === 0;
  $('obCancelAddBtn').hidden = !obIsAddingAnother;
  $('obValidationMsg').textContent = '';

  for (let i = 0; i < 6; i += 1) {
    const panel = $(`obStep${i}`);
    const active = i === obStep;
    panel.hidden = !active;
    if (!active) {
      panel.classList.remove('anim-next', 'anim-prev');
    } else if (animateDir === 'next' || animateDir === 'prev') {
      panel.classList.remove('anim-next', 'anim-prev');
      void panel.offsetWidth;
      const cls = animateDir === 'prev' ? 'anim-prev' : 'anim-next';
      panel.classList.add(cls);
      panel.addEventListener('animationend', () => panel.classList.remove(cls), { once: true });
    }
  }

  if (obStep === 0) $('obNextBtn').textContent = t('ob.welcome.cta');
  else if (obStep === 5) $('obNextBtn').textContent = t('ob.setup.finish');
  else $('obNextBtn').textContent = t('common.continue');
}

function openOnboarding({ addingAnother = false } = {}) {
  obIsAddingAnother = addingAnother;
  obStep = 0;
  obState.language = addingAnother ? getLanguage() : 'en';
  obState.name = '';
  obState.handle = '';
  obState.baseCurrency = 'USD';
  obState.streamlabsToken = '';
  obState.streamlabsVerified = false;
  obState.streamPlatforms = new Set(['youtube']);
  obState.twitchSplitCutPct = 50;
  obState.donationPlatforms = new Set(['streamlabs']);
  obState.extraCreds = {};
  obState.draftWebhookToken = bootData?.draftWebhookToken || '';

  setLanguage(obState.language);
  const startMeta = LANGUAGE_META.find((l) => l.code === obState.language) || LANGUAGE_META[0];
  $('obHelloWord').textContent = startMeta.greeting;
  $('obHelloWord').lang = startMeta.code;
  $('obProfName').value = '';
  $('obProfHandle').value = '';
  $('obSlToken').value = '';
  $('obSlVerifyStatus').hidden = true;
  $('obSlIllustration').innerHTML = STREAMLABS_GUIDE_SVG;
  $('obObsIllustration').innerHTML = OBS_GUIDE_SVG;
  $('obHelloMark').innerHTML = APP_MARK_SVG;
  populateCurrencySelect($('obBaseCurrency'), 'USD', false);
  renderOnboardingLangCards();
  renderOnboardingSwatches();
  renderOnboardingDonationCatalog();
  updateOnboardingCurrencyPreview();
  renderOnboardingStepChrome(null);
  startHelloCycle(Math.max(0, LANGUAGE_META.findIndex((l) => l.code === obState.language)));

  document.body.classList.remove('in-workspace');
  $('tbTrayBtn').hidden = true;
  $('appRoot').hidden = true;
  $('onboardingRoot').hidden = false;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function finishOnboarding() {
  $('obNextBtn').disabled = true;
  try {
    const integrations = {
      streamlabs: {
        enabled: true,
        socketToken: obState.streamlabsToken,
      },
    };
    for (const [platId, creds] of Object.entries(obState.extraCreds)) {
      const hasVal = Object.entries(creds).some(([k, v]) => k !== 'enabled' && typeof v === 'string' && v.trim());
      if (hasVal) integrations[platId] = { ...creds, enabled: true };
    }

    const res = await api('/api/profiles', {
      method: 'POST',
      body: {
        name: obState.name || 'Main Profile',
        handle: obState.handle,
        language: obState.language,
        baseCurrency: obState.baseCurrency,
        avatarColor: obState.avatarColor,
        streamPlatforms: [...obState.streamPlatforms],
        donationPlatforms: [...obState.donationPlatforms],
        twitchSplitCutPct: obState.twitchSplitCutPct,
        webhookSecret: obState.draftWebhookToken || undefined,
        integrations,
      },
    });
    if (!res.ok) {
      $('obValidationMsg').textContent = 'Could not create profile.';
      return;
    }
    if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
    activeView = 'home';
    $('onboardingRoot').hidden = true;
    await hydrateActiveWorkspace();
    showToast(`Welcome, ${res.data.profile.name}!`);
  } finally {
    $('obNextBtn').disabled = false;
  }
}

// -------------------------------------------------- Profile Switcher --------

function renderProfileHeaderAndMenu() {
  if (!activeProfile) return;
  const init = (activeProfile.name || 'P').trim().charAt(0).toUpperCase();
  for (const av of [$('profileAvatar'), $('popAvatar')]) {
    av.textContent = init;
    av.style.backgroundColor = activeProfile.avatarColor || '#0071e3';
  }
  $('profileNameShort').textContent = activeProfile.name;
  $('popName').textContent = activeProfile.name;
  $('popMeta').textContent = `${activeProfile.language.toUpperCase()} · ${activeProfile.baseCurrency} · ${activeProfile.streamPlatforms.join(' + ')}`;
  $('homeProfilePill').textContent = `${activeProfile.name} · ${activeProfile.baseCurrency} · ${activeProfile.language.toUpperCase()}`;

  const list = $('popProfileList');
  list.replaceChildren();
  for (const p of bootData?.profiles || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pop-item${p.id === activeProfile.id ? ' is-active' : ''}`;
    b.dataset.switchProfile = p.id;
    b.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;"><span class="prof-avatar" style="width:20px;height:20px;font-size:10px;background:${p.avatarColor};">${(p.name || 'P')[0].toUpperCase()}</span><span>${p.name}</span></span><span style="font-size:11px;opacity:0.75;">${p.baseCurrency}</span>`;
    list.append(b);
  }
}

function toggleProfilePopover(force) {
  const pop = $('profilePopover');
  const open = typeof force === 'boolean' ? force : pop.hidden;
  pop.hidden = !open;
  $('profileMenuBtn').setAttribute('aria-expanded', String(open));
}

// -------------------------------------------------- Workspace Hydration -----

async function hydrateActiveWorkspace() {
  const boot = await api('/api/app/bootstrap');
  if (!boot.ok) return;
  bootData = boot.data;
  applyAppearance(bootData.appearance || 'system');

  if (bootData.needsOnboarding || !bootData.activeProfile) {
    openOnboarding({ addingAnother: false });
    return;
  }

  activeProfile = bootData.activeProfile;
  setBaseCurrency(activeProfile.baseCurrency);
  setLanguage(activeProfile.language);

  $('onboardingRoot').hidden = true;
  $('appRoot').hidden = false;
  document.body.classList.add('in-workspace');
  $('tbTrayBtn').hidden = !document.body.classList.contains('is-desktop');

  renderProfileHeaderAndMenu();
  populateCurrencySelect($('donoCurrency'), activeProfile.baseCurrency, true);
  populateCurrencySelect($('simSlCur'), activeProfile.baseCurrency, true);
  populateCurrencySelect($('simWhCur'), activeProfile.baseCurrency, true);
  populateLanguageSelect($('setLangSelect'), activeProfile.language);
  $('hkToggle').value = bootData.hotkeys?.toggle || 'CommandOrControl+Shift+Space';
  $('hkAdd1').value = bootData.hotkeys?.add1m || 'CommandOrControl+Shift+Up';
  $('hkAdd5').value = bootData.hotkeys?.add5m || 'CommandOrControl+Shift+Right';
  $('setCloseToTrayChk').checked = Boolean(bootData.closeToTray);
  if (bootData.updates) {
    renderUpdateStatus(bootData.updates);
    if (bootData.updates.autoCheck && bootData.updates.status === 'idle') {
      api('/api/updates/check', { method: 'POST', body: {} }).then(async (r) => {
        if (!r.ok || !r.data?.updates) return;
        renderUpdateStatus(r.data.updates);
        if (r.data.updates.status === 'update_available' && r.data.updates.autoInstall) {
          const st = await api('/api/updates/status');
          if (st.ok && !st.data?.isStreamingBusy) {
            const dl = await api('/api/updates/download', { method: 'POST' });
            if (dl.ok && dl.data?.status) {
              renderUpdateStatus(dl.data.status);
              showToast(`Update v${dl.data.status.latestVersion} verified & ready to install`);
            }
          }
        }
      }).catch(() => {});
    }
  }

  if (!link) {
    link = createTimerLink({
      onFrame: (frame) => { snapshot = frame; },
      onFreshness: (ok) => {
        $('connPill').dataset.state = ok ? 'live' : 'reconnecting';
        $('connLabel').textContent = ok ? t('status.live') : t('status.reconnecting');
      },
      onOverlay: (cfg) => { overlayCfg = { ...overlayCfg, ...cfg }; syncOverlayControls(); },
      onActivity: () => {
        if (activeView === 'home') loadHome();
        if (activeView === 'donations') loadDonations();
        if (activeView === 'finance') loadFinance();
        if (activeView === 'integrations') loadIntegrations();
      },
    });
    link.start();
  } else {
    link.resetAnchor();
    link.refresh();
  }

  if (!rAFStarted) {
    rAFStarted = true;
    requestAnimationFrame(renderClockTick);
  }

  await Promise.all([loadRules(), loadOverlay(), loadDonations(), loadHome(), loadIntegrations(), loadFinance()]);
  renderFxRatesList();
  switchView(activeView || 'home');
  requestAnimationFrame(() => requestAnimationFrame(() => updateNavThumb(true)));
}

function renderClockTick() {
  const rem = remainingAt(snapshot, performance.now());
  const clock = formatClock(formatSeconds(rem ?? 0));
  const running = snapshot && snapshot.state === 'running';
  $('countdown').textContent = clock;
  $('homeClock').textContent = clock;
  $('obsPrevClock').textContent = clock;

  const stateTxt = overlayCfg.rushOn
    ? `BILLING RUSH LV.${overlayCfg.rushLv}`
    : (running ? t('status.running').toUpperCase() : t('status.paused').toUpperCase());
  $('timerStatePill').textContent = stateTxt;
  $('homeStatePill').textContent = stateTxt;

  const btnTxt = running ? t('timer.pause') : t('timer.resume');
  $('toggleBtn').textContent = btnTxt;
  $('homeToggleBtn').textContent = btnTxt;
  requestAnimationFrame(renderClockTick);
}

async function sendTimerCommand(command) {
  const r = await api('/api/command', { method: 'POST', body: command });
  if (r.ok) {
    await link?.refresh();
    showToast(`${command.type.toUpperCase()} applied`);
  }
}

// -------------------------------------------------- Home Mission Control ----

async function loadHome() {
  const r = await api('/api/home');
  if (!r.ok) return;
  const h = r.data;
  const cur = h.profile.baseCurrency;

  $('homeObsCount').textContent = `OBS Overlay: ${h.clients.obs} connected`;
  $('obsConnBadge').textContent = `${h.clients.obs} source${h.clients.obs === 1 ? '' : 's'}`;
  $('homeQaRushSub').textContent = h.overlay.rushOn ? `Active Lv.${h.overlay.rushLv}` : 'Inactive';

  // Readiness checklist
  const list = $('homeReadinessList');
  list.replaceChildren();
  const sl = h.sockets.streamlabs;
  const checks = [
    {
      label: 'Streamlabs Socket API',
      status: sl.status === 'connected' ? 'ok' : (sl.hasToken ? 'warn' : 'off'),
      detail: sl.status === 'connected' ? 'Connected' : (sl.hasToken ? sl.status : 'Token needed'),
      goto: 'integrations',
    },
    {
      label: 'OBS Browser Source',
      status: h.clients.obs > 0 ? 'ok' : 'warn',
      detail: h.clients.obs > 0 ? `${h.clients.obs} live` : 'Not attached yet',
      goto: 'overlay',
    },
    {
      label: 'Live Exchange Rates (FX)',
      status: h.fx.lastUpdatedAtMs > 0 ? 'ok' : 'warn',
      detail: h.fx.lastUpdatedAtMs > 0 ? `${h.fx.currencyCount} live (${h.fx.provider})` : 'Baseline',
      goto: 'settings',
    },
    {
      label: 'Local Webhook Tunnel',
      status: h.tunnel.status === 'active' ? 'ok' : 'off',
      detail: h.tunnel.status === 'active' ? 'HTTPS Active' : 'Off (optional)',
      goto: 'integrations',
    },
  ];
  for (const c of checks) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'check-row';
    b.innerHTML = `<span class="check-left"><span class="check-dot ${c.status}"></span>${c.label}</span><span class="check-right">${c.detail}</span>`;
    b.addEventListener('click', () => switchView(c.goto));
    list.append(b);
  }

  // Revenue Pulse
  $('homeActiveNet').textContent = fmtMoney(h.activeIncome.netAmount, cur);
  $('homeActiveSub').textContent = `Gross ${fmtMoney(h.activeIncome.grossAmount, cur)} · ${h.activeIncome.txCount} tx · ${h.activeIncome.effectiveFeePct}% cut`;
  if (h.lastArchivedSession) {
    $('homePrevLabel').textContent = h.lastArchivedSession.label;
    $('homePrevNet').textContent = fmtMoney(h.lastArchivedSession.netAmount, cur);
  } else {
    $('homePrevLabel').textContent = 'No archived cycle yet';
    $('homePrevNet').textContent = '—';
  }

  // Latest 4 activity cards
  const strip = $('homeActivityStrip');
  strip.replaceChildren();
  if (!h.recentDonations.length) {
    const empty = document.createElement('p');
    empty.className = 'helper-text';
    empty.style.gridColumn = '1 / -1';
    empty.textContent = t('home.noActivity');
    strip.append(empty);
    return;
  }
  for (const d of h.recentDonations.slice(0, 4)) {
    const card = document.createElement('div');
    card.className = 'act-pill-card';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
        <strong style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.gifterName}</strong>
        <span class="text-accent" style="font-family:var(--font-mono);font-size:11.5px;">+${fmtDuration(d.creditMs)}</span>
      </div>
      <div style="font-family:var(--font-mono);font-size:12.5px;font-weight:600;">${fmtMoney(d.grossAmount, cur)}</div>
      <div style="font-size:11px;color:var(--muted);">${d.provider} · ${fmtDateTime(d.appliedAtMs)}</div>
    `;
    strip.append(card);
  }
}

// -------------------------------------------------- Donations ---------------

function syncDonoFormMode() {
  const src = $('donoSource').value;
  const isYtMem = src === 'yt_member' || src === 'yt_gift_member';
  const isTwSub = src === 'twitch_sub' || src === 'twitch_gift_sub';
  const isUnits = src === 'yt_jewels' || src === 'twitch_bits';
  const isPrime = src === 'twitch_prime';
  const isCash = !isYtMem && !isTwSub && !isUnits && !isPrime;

  $('donoCashWrap').hidden = !isCash;
  $('donoYtWrap').hidden = !isYtMem;
  $('donoYtQtyWrap').hidden = src !== 'yt_gift_member';
  $('donoTwWrap').hidden = !isTwSub;
  $('donoTwQtyWrap').hidden = src !== 'twitch_gift_sub';
  $('donoUnitsWrap').hidden = !isUnits;
  if (isUnits) $('donoUnitsLbl').textContent = src === 'yt_jewels' ? 'Jewels Count' : 'Bits Count';
  $('donoPreviewPill').textContent = isPrime ? 'Prime' : (isCash ? $('donoCurrency').value || getCurrency() : 'Auto');
}

async function loadDonations() {
  const r = await api('/api/donations');
  if (!r.ok) return;
  donations = r.data.donations || [];
  const s = r.data.stats;
  const cur = getCurrency();
  const mins = Math.floor((s.totalCreditMs || 0) / 60000);
  const addedTxt = `${Math.floor(mins / 60)}h ${mins % 60}m`;
  $('statGross').textContent = fmtMoney(s.totalGross, cur);
  $('statAdded').textContent = addedTxt;
  $('statCount').textContent = String(s.totalCount);
  $('donoChipGross').textContent = fmtMoney(s.totalGross, cur);
  $('donoChipAdded').textContent = addedTxt;
  $('obsPrevTot').textContent = `${(overlayCfg.totalName || 'Total Added').toUpperCase()} · ${addedTxt}`;
  renderDonationsTable();
}

function renderDonationsTable() {
  const cur = getCurrency();
  const q = $('donoSearch').value.trim().toLowerCase();
  const sort = $('donoSort').value;
  let rows = donations.filter((d) => !q || d.gifterName.toLowerCase().includes(q) || d.provider.toLowerCase().includes(q) || (d.originalCurrency || '').toLowerCase().includes(q));
  if (sort === 'oldest') rows = [...rows].sort((a, b) => a.appliedAtMs - b.appliedAtMs);
  else if (sort === 'highest') rows = [...rows].sort((a, b) => b.grossAmount - a.grossAmount);

  $('donoBulkBar').hidden = !donoSelectMode;
  $('donoSelColHead').hidden = !donoSelectMode;
  $('donoSelCount').textContent = `${donoSelected.size} selected`;
  $('donoDelSelBtn').disabled = donoSelected.size === 0;

  const tbody = $('donoBody');
  tbody.replaceChildren();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="helper-text" style="text-align:center;padding:18px;">No donations recorded yet.</td></tr>';
    return;
  }
  for (const d of rows) {
    const tr = document.createElement('tr');
    const origSub = d.originalCurrency && d.originalCurrency !== cur && d.originalAmount
      ? `<span class="amt-sub">${d.originalAmount} ${d.originalCurrency}</span>` : '';
    tr.innerHTML = `
      ${donoSelectMode ? `<td><input type="checkbox" data-sel-dono="${d.eventId}" ${donoSelected.has(d.eventId) ? 'checked' : ''} aria-label="Select ${d.gifterName}"></td>` : ''}
      <td>${fmtDateTime(d.appliedAtMs)}</td>
      <td><strong>${d.gifterName}</strong></td>
      <td><span class="pill">${d.provider}${d.tierOrLevel ? ` · ${d.tierOrLevel}` : ''}</span></td>
      <td class="num">${fmtMoney(d.grossAmount, cur)}${origSub}</td>
      <td class="num text-accent">+${fmtDuration(d.creditMs)}</td>
      <td class="num"><button type="button" class="btn btn-link" style="color:var(--danger);" data-del-dono="${d.eventId}">Remove</button></td>
    `;
    tbody.append(tr);
  }
}

// -------------------------------------------------- Finance -----------------

function buildFinParams({ sessionOverride = null, ledgerFilters = false } = {}) {
  const sp = new URLSearchParams();
  sp.set('session', sessionOverride ?? finScope ?? 'current');
  if (ledgerFilters) {
    const q = $('finSearch').value.trim();
    if (q) sp.set('q', q);
    if ($('finLdChan').value && $('finLdChan').value !== 'all') sp.set('channel', $('finLdChan').value);
    if ($('finLdCur').value && $('finLdCur').value !== 'all') sp.set('currency', $('finLdCur').value);
    if ($('finFromDt').value) { const ms = Date.parse($('finFromDt').value); if (Number.isFinite(ms)) sp.set('fromMs', String(ms)); }
    if ($('finToDt').value) { const ms = Date.parse($('finToDt').value); if (Number.isFinite(ms)) sp.set('toMs', String(ms)); }
    const mg = Number($('finMinGross').value);
    if (Number.isFinite(mg) && mg > 0) sp.set('minGross', String(mg));
    if ($('finSort').value) sp.set('sort', $('finSort').value);
    if ($('finIncDel').checked) sp.set('includeDeleted', 'true');
  }
  return sp;
}

async function loadFinance() {
  const ovP = buildFinParams({ ledgerFilters: false });
  const ldSess = $('finLdSess').value || finScope || 'current';
  const ldP = buildFinParams({ sessionOverride: ldSess, ledgerFilters: true });
  const [ovRes, ldRes] = await Promise.all([
    api(`/api/finance/report?${ovP.toString()}`),
    ovP.toString() === ldP.toString() ? Promise.resolve(null) : api(`/api/finance/report?${ldP.toString()}`),
  ]);
  if (!ovRes.ok) return;
  const ov = ovRes.data;
  const ld = ldRes?.ok ? ldRes.data : ov;
  finData = { overview: ov, ledger: ld };

  // Populate Session Dropdowns
  for (const [sel, val] of [[$('finScopeSel'), finScope], [$('finLdSess'), ldSess]]) {
    sel.replaceChildren();
    sel.append(new Option(`Current: ${ov.activeSession.label} (Active)`, 'current'));
    sel.append(new Option('All-Time (All Sessions)', 'all'));
    for (const s of ov.sessions) {
      sel.append(new Option(`${s.label} (${fmtMoney(s.netAmount, ov.baseCurrency)})`, s.sessionId));
    }
    sel.value = val;
    if (!sel.value) sel.value = 'current';
  }

  // Populate channel selectors
  if ($('finLdChan').options.length === 0 && ov.config?.channels) {
    $('finLdChan').append(new Option('All Platforms', 'all'));
    for (const [k, ch] of Object.entries(ov.config.channels)) {
      $('finLdChan').append(new Option(ch.label, k));
      $('finSimChan').append(new Option(ch.label, k));
    }
    $('finSimChan').value = 'yt_superchat';
  }

  renderFinanceOverview(ov);
  renderFinanceLedger(ld);
  renderFinanceSessions(ov);
  renderFinanceFees(ov.config);
}

function renderFinanceOverview(ov) {
  const cur = ov.baseCurrency;
  const s = ov.summary;
  $('finScopeMeta').textContent = ov.scope.sessionId === 'all'
    ? `All ${ov.sessions.length} cycles combined`
    : (ov.scope.isActive ? `Active · Started ${fmtDateTime(ov.scope.startedAtMs)}` : `Archived · ${fmtDateTime(ov.scope.startedAtMs)} → ${fmtDateTime(ov.scope.endedAtMs)}`);

  $('finKpiGross').textContent = fmtMoney(s.grossAmount, cur);
  $('finKpiGrossSub').textContent = `${s.txCount} tx · 100% gross`;
  $('finKpiDeduct').textContent = `-${fmtMoney(s.totalDeductions, cur)}`;
  $('finKpiDeductSub').textContent = `${s.effectiveFeePct}% effective cut`;
  $('finKpiNet').textContent = fmtMoney(s.netAmount, cur);
  $('finKpiNetSub').textContent = `${s.takeHomePct}% take-home`;
  $('finKpiAvg').textContent = fmtMoney(s.avgNet, cur);
  $('finKpiAvgSub').textContent = `Avg Gross ${fmtMoney(s.avgGross, cur)}`;

  $('finCutBadge').textContent = `${s.effectiveFeePct}% cut`;
  $('finBrkPlat').textContent = `-${fmtMoney(s.platformFee, cur)}`;
  $('finBrkPay').textContent = `-${fmtMoney(s.paymentFee, cur)}`;
  $('finBrkFix').textContent = `-${fmtMoney(s.fixedFee, cur)}`;
  $('finBrkTax').textContent = `-${fmtMoney(s.taxReserve, cur)}`;
  $('finBrkNet').textContent = fmtMoney(s.netAmount, cur);

  if (s.grossAmount > 0) {
    $('finBarNet').style.width = `${(s.netAmount / s.grossAmount) * 100}%`;
    $('finBarPlat').style.width = `${(s.platformFee / s.grossAmount) * 100}%`;
    $('finBarPay').style.width = `${((s.paymentFee + s.fixedFee) / s.grossAmount) * 100}%`;
    $('finBarTax').style.width = `${(s.taxReserve / s.grossAmount) * 100}%`;
  } else {
    $('finBarNet').style.width = '100%';
    $('finBarPlat').style.width = '0%';
    $('finBarPay').style.width = '0%';
    $('finBarTax').style.width = '0%';
  }

  const body = $('finChanBody');
  body.replaceChildren();
  if (!ov.byChannel.length) {
    body.innerHTML = '<tr><td colspan="5" class="helper-text" style="text-align:center;padding:18px;">No revenue recorded in this cycle yet.</td></tr>';
    return;
  }
  for (const ch of ov.byChannel) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${ch.channelLabel}</strong><span class="amt-sub">${ch.platformFeePct}% plat · ${ch.paymentFeePct}% pay</span></td>
      <td class="num">${ch.txCount}</td>
      <td class="num">${fmtMoney(ch.grossAmount, cur)}</td>
      <td class="num text-neg">-${fmtMoney(ch.totalDeductions, cur)}<span class="amt-sub">${ch.effectiveFeePct}%</span></td>
      <td class="num"><strong>${fmtMoney(ch.netAmount, cur)}</strong></td>
    `;
    body.append(tr);
  }
}

function renderFinanceLedger(ld) {
  const cur = ld.baseCurrency;
  const s = ld.summary;
  $('finLdSum').innerHTML = `<span>Showing ${ld.transactions.length} of ${ld.totalMatched} (${ld.scope.label})</span><span>Gross ${fmtMoney(s.grossAmount, cur)} · Cut -${fmtMoney(s.totalDeductions, cur)} (${s.effectiveFeePct}%) · Net ${fmtMoney(s.netAmount, cur)}</span>`;
  const body = $('finLdBody');
  body.replaceChildren();
  if (!ld.transactions.length) {
    body.innerHTML = '<tr><td colspan="7" class="helper-text" style="text-align:center;padding:18px;">No matching transactions.</td></tr>';
    return;
  }
  for (const tx of ld.transactions) {
    const tr = document.createElement('tr');
    tr.dataset.click = '1';
    tr.dataset.txId = tx.eventId;
    const orig = tx.originalCurrency !== cur ? `<span class="amt-sub">${tx.originalAmount} ${tx.originalCurrency}</span>` : '';
    tr.innerHTML = `
      <td>${fmtDateTime(tx.appliedAtMs)}<span class="amt-sub">${tx.sessionLabel}</span></td>
      <td><strong>${tx.gifterName}</strong><span class="amt-sub" style="font-family:var(--font-mono);">${tx.eventId}</span></td>
      <td><span class="pill">${tx.channelLabel}</span></td>
      <td class="num">${fmtMoney(tx.grossAmount, cur)}${orig}</td>
      <td class="num text-neg">-${fmtMoney(tx.totalDeductions, cur)}<span class="amt-sub">${tx.effectiveFeePct}%</span></td>
      <td class="num"><strong>${fmtMoney(tx.netAmount, cur)}</strong></td>
      <td class="num"><button type="button" class="btn btn-link" data-inspect-tx="${tx.eventId}">Inspect</button></td>
    `;
    body.append(tr);
  }
}

function renderFinanceSessions(ov) {
  const cur = ov.baseCurrency;
  $('finSessCount').textContent = `${ov.sessions.length} session${ov.sessions.length === 1 ? '' : 's'}`;
  const list = $('finSessList');
  list.replaceChildren();
  for (const s of ov.sessions) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '12px 14px';
    card.style.borderColor = s.isActive ? 'var(--accent)' : 'var(--border-soft)';
    card.innerHTML = `
      <div class="card-head" style="margin-bottom:8px;">
        <div><strong>${s.label}</strong><div class="helper-text">${s.isActive ? `Active · Started ${fmtDateTime(s.startedAtMs)}` : `${fmtDateTime(s.startedAtMs)} → ${fmtDateTime(s.endedAtMs)}`}</div></div>
        <span class="pill ${s.isActive ? 'pill-ok' : ''}">${s.isActive ? 'Active' : 'Archived'}</span>
      </div>
      <div class="row-3" style="margin-bottom:8px;font-family:var(--font-mono);font-size:12.5px;">
        <div><span class="amt-sub">Gross</span><strong>${fmtMoney(s.grossAmount, cur)}</strong></div>
        <div><span class="amt-sub">Deductions</span><strong class="text-neg">-${fmtMoney(s.totalDeductions, cur)}</strong></div>
        <div><span class="amt-sub">Net (${s.txCount} tx)</span><strong>${fmtMoney(s.netAmount, cur)}</strong></div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-sm" data-open-sess="${s.sessionId}">Open in Ledger</button>
        <button type="button" class="btn btn-sm" data-exp-sess="${s.sessionId}">Export</button>
      </div>
    `;
    list.append(card);
  }
}

function renderFinanceFees(cfg) {
  if (!cfg) return;
  $('finTaxPct').value = String(cfg.taxReservePct ?? 0);
  $('finTaxBasis').value = cfg.taxBasis || 'after_fees';
  const box = $('finFeeMatrix');
  box.replaceChildren();
  for (const [k, ch] of Object.entries(cfg.channels || {})) {
    const row = document.createElement('div');
    row.className = 'fee-matrix-row';
    row.innerHTML = `
      <strong style="font-size:12.5px;">${ch.label}</strong>
      <input type="number" min="0" max="100" step="0.1" value="${ch.platformFeePct}" data-fk="${k}" data-ff="platformFeePct" aria-label="${ch.label} platform fee percent">
      <input type="number" min="0" max="100" step="0.1" value="${ch.paymentFeePct}" data-fk="${k}" data-ff="paymentFeePct" aria-label="${ch.label} payment fee percent">
      <input type="number" min="0" step="any" value="${ch.fixedFee}" data-fk="${k}" data-ff="fixedFee" aria-label="${ch.label} fixed fee">
    `;
    box.append(row);
  }
  updateFinFormulaSim();
}

function readFinFeeControls() {
  const channels = {};
  $('finFeeMatrix').querySelectorAll('input[data-fk]').forEach((inp) => {
    const k = inp.dataset.fk;
    if (!channels[k]) channels[k] = {};
    channels[k][inp.dataset.ff] = Number(inp.value) || 0;
  });
  return {
    taxReservePct: Number($('finTaxPct').value) || 0,
    taxBasis: $('finTaxBasis').value,
    channels,
  };
}

function updateFinFormulaSim() {
  const cfg = readFinFeeControls();
  const cur = getCurrency();
  const ch = cfg.channels[$('finSimChan').value] || { platformFeePct: 0, paymentFeePct: 0, fixedFee: 0 };
  const gross = Math.max(0, Number($('finSimAmt').value) || 0);
  const plat = gross * (ch.platformFeePct / 100);
  const pay = gross * (ch.paymentFeePct / 100);
  const fix = gross > 0 ? Math.min(gross, ch.fixedFee) : 0;
  const pre = Math.min(gross, plat + pay + fix);
  const tax = (cfg.taxBasis === 'gross' ? gross : Math.max(0, gross - pre)) * (cfg.taxReservePct / 100);
  const tot = Math.min(gross, pre + tax);
  const net = Math.max(0, gross - tot);
  $('finFormulaBox').textContent = `${fmtMoney(gross, cur)} - Platform ${fmtMoney(plat, cur)} (${ch.platformFeePct}%) - Pay ${fmtMoney(pay + fix, cur)} - Tax ${fmtMoney(tax, cur)} (${cfg.taxReservePct}%) = Net ${fmtMoney(net, cur)}`;
}

function openTxInspector(eventId) {
  const list = finData?.ledger?.transactions || [];
  const tx = list.find((x) => x.eventId === eventId);
  if (!tx) return;
  finInspectEventId = tx.eventId;
  const cur = tx.baseCurrency || getCurrency();
  $('finDetContent').innerHTML = `
    <div class="row-2" style="font-size:12.5px;">
      <div><span class="amt-sub">Date &amp; Time</span><strong>${fmtDateTime(tx.appliedAtMs, { full: true })}</strong></div>
      <div><span class="amt-sub">Session</span><strong>${tx.sessionLabel}</strong></div>
      <div><span class="amt-sub">Donor</span><strong>${tx.gifterName}</strong></div>
      <div><span class="amt-sub">Platform</span><strong>${tx.channelLabel}</strong></div>
      <div><span class="amt-sub">Event ID</span><strong style="font-family:var(--font-mono);font-size:11.5px;">${tx.eventId}</strong></div>
      <div><span class="amt-sub">Original</span><strong>${tx.originalAmount} ${tx.originalCurrency}</strong></div>
    </div>
    <div class="mono-box">
      <div class="fin-deduct-row"><span>Gross</span><strong>${fmtMoney(tx.grossAmount, cur)}</strong></div>
      <div class="fin-deduct-row"><span>Platform Cut (${tx.platformFeePct}%)</span><span class="text-neg">-${fmtMoney(tx.platformFee, cur)}</span></div>
      <div class="fin-deduct-row"><span>Payment Fee (${tx.paymentFeePct}%)</span><span class="text-neg">-${fmtMoney(tx.paymentFee, cur)}</span></div>
      <div class="fin-deduct-row"><span>Fixed Fee</span><span class="text-neg">-${fmtMoney(tx.fixedFee, cur)}</span></div>
      <div class="fin-deduct-row"><span>Tax Reserve (${tx.taxReservePct}%)</span><span class="text-neg">-${fmtMoney(tx.taxReserve, cur)}</span></div>
      <div class="fin-deduct-row is-tot"><span>Net Take-Home</span><strong>${fmtMoney(tx.netAmount, cur)}</strong></div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted);">${tx.formulaText}</div>
    </div>
  `;
  $('finDetailDialog').showModal();
}

async function doFinanceExport(fmt) {
  const sp = buildFinParams({
    sessionOverride: finExportScopeOverride ?? (finExportFromLedger ? ($('finLdSess').value || finScope) : finScope),
    ledgerFilters: finExportFromLedger,
  });
  sp.set('format', fmt);
  const res = await fetch(`/api/finance/export?${sp.toString()}`);
  if (!res.ok) { showToast(`Export failed (${res.status})`); return; }
  if (fmt === 'html') {
    const html = await res.text();
    const u = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    window.open(u, '_blank', 'noopener');
    showToast('Opened printable Financial Statement');
    return;
  }
  const blob = await res.blob();
  const m = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/);
  const fn = m ? m[1] : `stream-finance.${fmt}`;
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = fn; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 8000);
  showToast(`Exported ${fn}`);
}

// -------------------------------------------------- Rules & Settings --------

async function loadRules() {
  const r = await api('/api/rules');
  if (!r.ok) return;
  rulesData = r.data;
  draftRules = structuredClone(r.data);
  renderRulesUi();
  renderCatalogsUi();
}

function renderRulesUi() {
  if (!draftRules) return;
  const cur = draftRules.baseCurrency || getCurrency();
  $('rulesCurBadge').textContent = cur;
  $('newTierMinLbl').textContent = `Minimum Gift (${cur})`;
  $('rulesMode').value = draftRules.mode;
  const list = $('rulesTierList');
  list.replaceChildren();
  for (const ti of draftRules.tiers) {
    const row = document.createElement('div');
    row.className = 'fin-deduct-row';
    row.style.padding = '7px 10px';
    row.style.borderRadius = '10px';
    row.style.background = 'var(--surface)';
    row.innerHTML = `<span><strong>${fmtMoney(ti.minimumAmount, cur)}</strong> → <span class="text-accent">+${fmtDuration(ti.creditMs)}</span></span><button type="button" class="btn btn-link" style="color:var(--danger);" data-rm-tier="${ti.minimumAmount}">Remove</button>`;
    list.append(row);
  }

  const tr = draftRules.eventRules.timerTriggers;
  $('trCashTips').checked = tr.cashTips !== false;
  $('trYtSc').checked = tr.ytSuperchat !== false;
  $('trYtMem').checked = tr.ytMember !== false;
  $('trYtGift').checked = tr.ytGiftMember !== false;
  $('trYtJewels').checked = tr.ytJewels !== false;
  $('trTwSub').checked = tr.twitchSub !== false;
  $('trTwPrime').checked = tr.twitchPrime !== false;
  $('trTwGift').checked = tr.twitchGiftSub !== false;
  $('trTwBits').checked = tr.twitchBits !== false;
}

function renderCatalogsUi() {
  if (!draftRules) return;
  const cur = draftRules.baseCurrency || getCurrency();
  $('ytNewPriceLbl').textContent = `Price (${cur})`;
  const ytBox = $('ytLevelsList');
  ytBox.replaceChildren();
  $('donoYtLevel').replaceChildren();
  for (const l of draftRules.eventRules.ytLevels) {
    $('donoYtLevel').append(new Option(`${l.name} (${fmtMoney(l.price, cur)})`, l.name));
    const row = document.createElement('div');
    row.className = 'fin-deduct-row';
    row.style.padding = '8px 10px';
    row.style.borderRadius = '10px';
    row.style.background = 'var(--surface)';
    row.innerHTML = `<div><strong>${l.name}</strong>${l.isDefault ? ' <span class="pill pill-accent">Default</span>' : ''}<div class="helper-text">${fmtMoney(l.price, cur)} · ${l.creditMode === 'follow_tiers' ? 'Follow Tiers' : `+${fmtDuration(l.fixedMs)}`}</div></div><button type="button" class="btn btn-link" style="color:var(--danger);" data-rm-yt="${l.name}">Remove</button>`;
    ytBox.append(row);
  }

  const twBox = $('twTierMatrix');
  twBox.replaceChildren();
  for (const k of ['prime', '1000', '2000', '3000']) {
    const tTier = draftRules.eventRules.twitchTiers[k];
    const row = document.createElement('div');
    row.className = 'row-3';
    row.style.alignItems = 'end';
    row.innerHTML = `
      <label class="field">${tTier.label} Price (${cur})<input type="number" step="any" value="${tTier.price}" data-twk="${k}" data-twf="price"></label>
      <label class="field">Credit Mode<select data-twk="${k}" data-twf="creditMode"><option value="fixed_time" ${tTier.creditMode === 'fixed_time' ? 'selected' : ''}>Fixed Minutes</option><option value="follow_tiers" ${tTier.creditMode === 'follow_tiers' ? 'selected' : ''}>Follow Tiers</option></select></label>
      <label class="field">Minutes<input type="number" min="0" value="${Math.round(tTier.fixedMs / 60000)}" data-twk="${k}" data-twf="min"></label>
    `;
    twBox.append(row);
  }
}

async function saveRulesToServer(toastMsg = 'Saved rules') {
  draftRules.mode = $('rulesMode').value;
  draftRules.eventRules.timerTriggers = {
    cashTips: $('trCashTips').checked,
    ytSuperchat: $('trYtSc').checked,
    ytMember: $('trYtMem').checked,
    ytGiftMember: $('trYtGift').checked,
    ytJewels: $('trYtJewels').checked,
    twitchSub: $('trTwSub').checked,
    twitchPrime: $('trTwPrime').checked,
    twitchGiftSub: $('trTwGift').checked,
    twitchBits: $('trTwBits').checked,
  };
  $('twTierMatrix').querySelectorAll('[data-twk]').forEach((c) => {
    const k = c.dataset.twk;
    const f = c.dataset.twf;
    if (f === 'price') draftRules.eventRules.twitchTiers[k].price = Number(c.value) || 0;
    else if (f === 'creditMode') draftRules.eventRules.twitchTiers[k].creditMode = c.value;
    else if (f === 'min') draftRules.eventRules.twitchTiers[k].fixedMs = Math.max(0, Math.round(Number(c.value) || 0)) * 60000;
  });
  const r = await api('/api/rules', { method: 'PUT', body: draftRules });
  if (r.ok) {
    rulesData = r.data;
    draftRules = structuredClone(r.data);
    renderRulesUi();
    renderCatalogsUi();
    showToast(toastMsg);
  }
}

// -------------------------------------------------- OBS Overlay -------------

function buildObsUrl(masked = true) {
  if (!activeProfile) return '';
  const tok = masked ? '••••••••' : encodeURIComponent(activeProfile.readToken);
  const bg = $('ovBg').value;
  const qs = [`profile=${encodeURIComponent(activeProfile.id)}`, `token=${tok}`];
  if (bg !== 'dark') qs.push(`bg=${bg}`);
  if (!$('ovPopup').checked) qs.push('popup=off');
  return `${window.location.origin}/source?${qs.join('&')}`;
}

function syncOverlayControls() {
  $('ovTimerName').value = overlayCfg.timerName || 'Stream Timer';
  $('ovTotalName').value = overlayCfg.totalName || 'Total Added';
  $('ovBg').value = overlayCfg.bgMode || 'dark';
  $('ovPos').value = overlayCfg.position || 'bottom-left';
  $('ovSize').value = String(overlayCfg.fontSize || 38);
  $('ovOpacity').value = String(overlayCfg.opacity ?? 92);
  $('ovShowTotal').checked = overlayCfg.showTotal !== false;
  $('ovPopup').checked = overlayCfg.popup !== false;
  applyObsPreview();
}

function applyObsPreview() {
  $('obsStage').dataset.bg = $('ovBg').value;
  $('obsPrevRush').hidden = !overlayCfg.rushOn;
  $('obsPrevLbl').textContent = ($('ovTimerName').value || 'Stream Timer').toUpperCase();
  $('obsPrevTot').hidden = !$('ovShowTotal').checked;
  $('obsPreviewCard').style.backgroundColor = `rgba(29,29,31,${((Number($('ovOpacity').value) || 92) / 100).toFixed(2)})`;
  $('obsUrlBox').textContent = buildObsUrl(!obsRevealed);
  $('obsRevealBtn').textContent = obsRevealed ? 'Hide URL' : 'Show Full URL';
}

async function loadOverlay() {
  const r = await api('/api/overlay-config');
  if (r.ok) { overlayCfg = { ...overlayCfg, ...r.data }; syncOverlayControls(); }
}

// -------------------------------------------------- Integrations & Tunnel ---

async function loadIntegrations() {
  const r = await api('/api/integrations');
  if (!r.ok) return;
  const data = r.data;
  const tunnel = data.tunnel;
  $('tunnelBadge').textContent = tunnel.status === 'active' ? 'Active HTTPS' : tunnel.status;
  $('tunnelBadge').className = `pill ${tunnel.status === 'active' ? 'pill-ok' : ''}`;
  $('tunnelUrlInput').value = tunnel.publicUrl || '';

  // Live Socket Cards (6 zero-tunnel local WebSocket platforms!)
  const sockGrid = $('socketCardsGrid');
  sockGrid.replaceChildren();
  const socketPlats = data.platforms.filter((p) => p.protocol === 'socket' || p.protocol === 'socket_or_webhook');
  const WEBHOOK_ONLY_KEYS = new Set(['webhookSecret', 'verificationToken', 'signingSecret', 'clientSecret']);
  for (const plat of socketPlats) {
    const st = data.sockets[plat.id] || { status: 'disconnected' };
    const cfg = data.configs[plat.id] || {};
    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <div><h3 class="card-title">${plat.name}</h3><span class="ob-country-tag">${plat.countryBadge}</span></div>
        <span class="pill ${st.status === 'connected' ? 'pill-ok' : (st.status === 'error' ? 'pill-danger' : '')}">${st.status}</span>
      </div>
      <p class="helper-text" style="margin-bottom:10px;">${st.lastError ? st.lastError : plat.guideSteps[0]}</p>
      <div class="stack-sm" data-sock-form="${plat.id}"></div>
    `;
    const form = card.querySelector(`[data-sock-form="${plat.id}"]`);
    const sockFields = (plat.credentialFields || []).filter((f) => !WEBHOOK_ONLY_KEYS.has(f.key));
    for (const f of sockFields) {
      const lbl = document.createElement('label');
      lbl.className = 'field';
      lbl.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = f.type || 'password';
      inp.dataset.credKey = f.key;
      inp.placeholder = cfg.hasCredentials ? '•••••••• (saved — enter new to replace)' : (f.placeholder || '');
      if (f.key === 'username' && cfg.username) inp.value = cfg.username;
      if (f.key === 'channelId' && cfg.channelId) inp.value = cfg.channelId;
      lbl.append(inp);
      form.append(lbl);
    }
    const btns = document.createElement('div');
    btns.className = 'btn-row';
    const saveB = document.createElement('button');
    saveB.type = 'button';
    saveB.className = 'btn btn-primary btn-pill btn-sm';
    saveB.textContent = 'Save & Connect';
    saveB.addEventListener('click', async () => {
      const payload = { enabled: true };
      form.querySelectorAll('[data-cred-key]').forEach((i) => { if (i.value.trim()) payload[i.dataset.credKey] = i.value.trim(); });
      const res = await api(`/api/integrations/${plat.id}`, { method: 'PUT', body: payload });
      if (res.ok) { showToast(`${plat.name} saved & connecting…`); loadIntegrations(); }
    });
    const discB = document.createElement('button');
    discB.type = 'button';
    discB.className = 'btn btn-pill btn-sm';
    discB.textContent = 'Disconnect';
    discB.addEventListener('click', async () => {
      await api(`/api/integrations/${plat.id}`, { method: 'PUT', body: { enabled: false } });
      showToast(`${plat.name} disconnected`);
      loadIntegrations();
    });
    btns.append(saveB, discB);
    form.append(btns);
    sockGrid.append(card);
  }

  // Regional & Global Webhook Cards (Ready-to-paste Public Secret URL + Per-Platform Token + Live Status)
  const whGrid = $('webhookCardsGrid');
  whGrid.replaceChildren();
  const whPlats = data.platforms.filter((p) => p.endpointPath);
  const simSel = $('simWhProv');
  const prevSim = simSel.value;
  simSel.replaceChildren();
  const urlSecret = data.webhookSecret || '';
  const hasPublicHttps = Boolean(tunnel.publicUrl);
  const lastWebhooks = data.lastWebhooks || {};

  for (const plat of whPlats) {
    simSel.append(new Option(`${plat.name} (${plat.countryBadge})`, plat.id));
    const url = `${tunnel.effectiveBaseUrl}${plat.endpointPath}${urlSecret ? `/${urlSecret}` : ''}`;
    const cfg = data.configs[plat.id] || {};
    const lastEv = lastWebhooks[plat.id] || null;
    const card = document.createElement('section');
    card.className = 'card';

    const statusBadge = hasPublicHttps
      ? '<span class="pill pill-ok">Public HTTPS ✓</span>'
      : '<span class="pill pill-warn">Start Tunnel Above</span>';

    const lastLine = lastEv
      ? (lastEv.ok
          ? `<div style="font-size:11.5px;color:var(--success);font-weight:600;margin-top:6px;">✓ Last received: ${fmtMoney(lastEv.originalAmount, lastEv.originalCurrency)} from ${lastEv.gifterName} (+${fmtDuration(lastEv.creditMs)})</div>`
          : `<div style="font-size:11.5px;color:var(--danger);font-weight:600;margin-top:6px;">✗ Last webhook rejected: ${lastEv.error}</div>`)
      : '';

    card.innerHTML = `
      <div class="card-head">
        <div><h3 class="card-title">${plat.name}</h3><span class="ob-country-tag">${plat.countryBadge}</span></div>
        ${statusBadge}
      </div>
      <div class="mono-box" style="margin-bottom:8px;">${url}</div>
      <div class="btn-row" style="justify-content:space-between;margin-bottom:8px;">
        <span class="helper-text" style="font-size:11.5px;">Auth: <code>${plat.signatureHeader}</code></span>
        <div class="btn-row">
          <button type="button" class="btn btn-sm btn-pill" data-copy-url="${url}">Copy URL</button>
          <button type="button" class="btn btn-sm btn-pill" data-quick-wh-test="${plat.id}">Test</button>
        </div>
      </div>
      <div data-wh-secret-wrap="${plat.id}"></div>
      ${lastLine}
    `;

    const secWrap = card.querySelector(`[data-wh-secret-wrap="${plat.id}"]`);
    if (plat.secretFieldKey) {
      const row = document.createElement('div');
      row.className = 'btn-row';
      row.style.marginTop = '4px';
      const inp = document.createElement('input');
      inp.type = 'password';
      inp.placeholder = cfg.hasCredentials ? '•••••••• (Token saved — enter new to replace)' : (plat.secretPlaceholder || 'Paste Webhook Token (optional)');
      inp.setAttribute('aria-label', `${plat.name} ${plat.secretLabel || 'Webhook Token'}`);
      inp.style.cssText = 'flex:1;min-width:140px;height:31px;padding:0 10px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--fg);font-size:12px;';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-sm btn-pill btn-primary';
      saveBtn.textContent = cfg.hasCredentials ? 'Update' : 'Save Token';
      saveBtn.addEventListener('click', async () => {
        const val = inp.value.trim();
        if (!val) { showToast(`Paste ${plat.name} token first`); return; }
        const r2 = await api(`/api/integrations/${plat.id}`, { method: 'PUT', body: { enabled: true, [plat.secretFieldKey]: val } });
        if (r2.ok) { showToast(`Saved ${plat.name} token`); loadIntegrations(); }
      });
      row.append(inp, saveBtn);
      if (cfg.hasCredentials) {
        const clrBtn = document.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'btn btn-sm btn-pill';
        clrBtn.textContent = 'Clear';
        clrBtn.addEventListener('click', async () => {
          const r2 = await api(`/api/integrations/${plat.id}`, { method: 'PUT', body: { clearToken: true } });
          if (r2.ok) { showToast(`Cleared ${plat.name} token (URL-token auth active)`); loadIntegrations(); }
        });
        row.append(clrBtn);
      }
      secWrap.append(row);
    } else {
      const note = document.createElement('div');
      note.className = 'helper-text';
      note.style.fontSize = '11.5px';
      note.textContent = 'No extra secret needed — this URL already embeds your private per-profile token.';
      secWrap.append(note);
    }

    whGrid.append(card);
  }
  if (prevSim) simSel.value = prevSim;
}

function renderUpdateStatus(upd) {
  if (!upd) return;
  $('updVersionPill').textContent = `v${upd.currentVersion || '1.0.0'}`;
  $('updAutoCheckChk').checked = upd.autoCheck !== false;
  $('updAutoInstallChk').checked = Boolean(upd.autoInstall);

  const badge = $('updStateBadge');
  const txt = $('updStatusText');
  const notes = $('updNotesBox');
  const instBtn = $('updInstallBtn');
  const hasNew = upd.status === 'update_available' || upd.status === 'ready_to_install';

  $('profUpdateDot').hidden = !hasNew;
  $('popUpdateBtn').hidden = !hasNew;
  if (hasNew && upd.latestVersion) {
    $('popUpdateLabel').textContent = `Update v${upd.latestVersion} Available`;
  }

  if (upd.status === 'update_available') {
    badge.className = 'pill pill-ok';
    badge.textContent = `v${upd.latestVersion} Available`;
    txt.textContent = `A new version (v${upd.latestVersion}) is ready. All profiles are backed up automatically before installing.`;
    notes.hidden = !upd.notes;
    notes.textContent = upd.notes || '';
    instBtn.hidden = false;
    instBtn.textContent = `Download & Install v${upd.latestVersion}`;
  } else if (upd.status === 'ready_to_install') {
    badge.className = 'pill pill-ok';
    badge.textContent = 'Ready to Install ✓';
    txt.textContent = `Stream Timer v${upd.latestVersion} is downloaded, verified (SHA-256), and ready.`;
    notes.hidden = !upd.notes;
    notes.textContent = upd.notes || '';
    instBtn.hidden = false;
    instBtn.textContent = 'Install & Relaunch Now';
  } else if (upd.status === 'up_to_date') {
    badge.className = 'pill pill-ok';
    badge.textContent = 'Up to Date ✓';
    txt.textContent = `Stream Timer v${upd.currentVersion} is the latest version.`;
    notes.hidden = true;
    instBtn.hidden = true;
  } else if (upd.status === 'error') {
    badge.className = 'pill pill-danger';
    badge.textContent = 'Offline / Error';
    txt.textContent = upd.lastError || 'Could not reach update service.';
    notes.hidden = true;
    instBtn.hidden = true;
  } else {
    badge.className = 'pill';
    badge.textContent = 'Automatic';
    txt.textContent = 'Stream Timer keeps your local profiles & SQLite databases 100% safe across updates.';
    notes.hidden = true;
    instBtn.hidden = true;
  }
}

async function loadUpdateStatus() {
  const r = await api('/api/updates/status');
  if (r.ok) renderUpdateStatus(r.data);
}

// -------------------------------------------------- FX Settings -------------

function renderFxRatesList() {
  const fx = bootData?.fx;
  if (!fx) return;
  const baseCur = getCurrency();
  const rates = fx.ratesPerUsd || {};
  const count = Object.keys(rates).length;
  $('fxAutoChk').checked = fx.autoUpdate !== false;
  $('fxIntSel').value = String(fx.intervalHours || 6);
  $('fxStatusBadge').textContent = fx.lastUpdatedAtMs > 0 ? 'Auto Live' : 'Baseline';
  $('fxInfoBox').textContent = fx.lastUpdatedAtMs > 0
    ? `Base: ${baseCur} · ${count} currencies via ${fx.provider} · Updated ${fmtDateTime(fx.lastUpdatedAtMs)}`
    : `Base: ${baseCur} · ${count} baseline currencies — click Update Rates Now`;

  const term = $('fxSearchIn').value.trim().toUpperCase();
  const codes = Object.keys(rates).filter((c) => c !== baseCur && (!term || c.includes(term))).sort();
  const box = $('fxRatesList');
  box.replaceChildren();
  const basePerUsd = Number(rates[baseCur]) || 1;
  for (const code of codes.slice(0, 80)) {
    const unitInBase = basePerUsd / (Number(rates[code]) || 1);
    const mult = unitInBase < 0.05 ? 1000 : (unitInBase < 0.5 ? 100 : 1);
    const row = document.createElement('div');
    row.className = 'fin-deduct-row';
    row.style.borderBottom = '1px solid var(--border-soft)';
    row.style.padding = '6px 2px';
    row.innerHTML = `<strong>${mult.toLocaleString('en-US')} ${code}</strong><span style="font-family:var(--font-mono);">${fmtMoney(unitInBase * mult, baseCur)}</span>`;
    box.append(row);
  }
}

// -------------------------------------------------- Event Wiring ------------

function bindAllEvents() {
  $('brandMark').innerHTML = APP_MARK_SVG;
  $('splashMark').innerHTML = APP_MARK_SVG;

  // Onboarding navigation
  $('obBaseCurrency').addEventListener('change', updateOnboardingCurrencyPreview);
  $('obCancelAddBtn').addEventListener('click', () => {
    if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
    $('onboardingRoot').hidden = true;
    $('appRoot').hidden = false;
    document.body.classList.add('in-workspace');
    $('tbTrayBtn').hidden = !document.body.classList.contains('is-desktop');
    requestAnimationFrame(() => updateNavThumb(true));
  });
  $('obBackBtn').addEventListener('click', () => {
    if (obStep > 0) { obStep -= 1; renderOnboardingStepChrome('prev'); }
  });
  $('obNextBtn').addEventListener('click', async () => {
    if (obStep === 1) {
      obState.name = $('obProfName').value.trim() || 'Main Channel';
      obState.handle = $('obProfHandle').value.trim();
      obState.baseCurrency = $('obBaseCurrency').value || 'USD';
    } else if (obStep === 2) {
      const tok = $('obSlToken').value.trim();
      if (!tok) {
        $('obValidationMsg').textContent = t('ob.sl.requiredHint');
        $('obSlToken').focus();
        return;
      }
      obState.streamlabsToken = tok;
    } else if (obStep === 3) {
      obState.twitchSplitCutPct = Number($('obTwSplitSelect').value) || 50;
    } else if (obStep === 4) {
      renderOnboardingStep5Setup();
    } else if (obStep === 5) {
      await finishOnboarding();
      return;
    }
    obStep += 1;
    renderOnboardingStepChrome('next');
  });

  $('obSlVerifyBtn').addEventListener('click', async () => {
    const tok = $('obSlToken').value.trim();
    const badge = $('obSlVerifyStatus');
    badge.hidden = false;
    badge.className = 'pill';
    badge.textContent = 'Checking…';
    const r = await api('/api/integrations/streamlabs/verify', { method: 'POST', body: { socketToken: tok } });
    if (r.ok && r.data?.ok) {
      obState.streamlabsVerified = true;
      badge.className = 'pill pill-ok';
      badge.textContent = 'Connected ✓';
    } else {
      badge.className = 'pill pill-danger';
      badge.textContent = r.data?.error || 'Verification failed';
    }
  });

  document.querySelectorAll('[data-stream-plat]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = b.dataset.streamPlat;
      if (obState.streamPlatforms.has(p)) {
        if (obState.streamPlatforms.size > 1) obState.streamPlatforms.delete(p);
      } else {
        obState.streamPlatforms.add(p);
      }
      b.classList.toggle('is-selected', obState.streamPlatforms.has(p));
      $('obTwSplitWrap').hidden = !obState.streamPlatforms.has('twitch');
    });
  });

  // Main navigation & sub-tabs
  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.goto)));

  document.querySelectorAll('[data-fin-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      const tId = b.dataset.finTab;
      document.querySelectorAll('[data-fin-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $('finPanelOverview').hidden = tId !== 'overview';
      $('finPanelLedger').hidden = tId !== 'ledger';
      $('finPanelSessions').hidden = tId !== 'sessions';
      $('finPanelFees').hidden = tId !== 'fees';
    });
  });
  document.querySelectorAll('[data-rules-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      const tId = b.dataset.rulesTab;
      document.querySelectorAll('[data-rules-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $('rulesPanelTiers').hidden = tId !== 'tiers';
      $('rulesPanelTriggers').hidden = tId !== 'triggers';
    });
  });
  document.querySelectorAll('[data-integ-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      const tId = b.dataset.integTab;
      document.querySelectorAll('[data-integ-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $('integPanelSockets').hidden = tId !== 'sockets';
      $('integPanelWebhooks').hidden = tId !== 'webhooks';
      $('integPanelTest').hidden = tId !== 'test';
    });
  });
  document.querySelectorAll('[data-set-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      const tId = b.dataset.setTab;
      document.querySelectorAll('[data-set-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $('setPanelYoutube').hidden = tId !== 'youtube';
      $('setPanelTwitch').hidden = tId !== 'twitch';
      $('setPanelCurrency').hidden = tId !== 'currency';
      $('setPanelDesktop').hidden = tId !== 'desktop';
    });
  });

  // Profile Popover Menu
  $('profileMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleProfilePopover(); });
  document.addEventListener('click', (e) => {
    if (!$('profilePopover').hidden && !e.target.closest('#profilePopover') && !e.target.closest('#profileMenuBtn')) {
      toggleProfilePopover(false);
    }
  });
  document.querySelectorAll('[data-theme-choice]').forEach((b) => {
    b.addEventListener('click', async () => {
      const mode = b.dataset.themeChoice;
      applyAppearance(mode, true);
      if (bootData) bootData.appearance = mode;
      await api('/api/app/settings', { method: 'PUT', body: { appearance: mode } });
    });
  });
  $('popProfileList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-switch-profile]');
    if (!btn) return;
    toggleProfilePopover(false);
    const r = await api('/api/profiles/switch', { method: 'POST', body: { profileId: btn.dataset.switchProfile } });
    if (r.ok) { await hydrateActiveWorkspace(); showToast(`Switched to ${r.data.profile.name}`); }
  });
  $('popAddBtn').addEventListener('click', () => { toggleProfilePopover(false); openOnboarding({ addingAnother: true }); });
  $('popEditBtn').addEventListener('click', () => {
    toggleProfilePopover(false);
    if (!activeProfile) return;
    $('edProfName').value = activeProfile.name;
    populateLanguageSelect($('edProfLang'), activeProfile.language);
    populateCurrencySelect($('edProfCur'), activeProfile.baseCurrency, false);
    $('edProfResetPresets').checked = false;
    $('editProfileDialog').showModal();
  });
  $('editProfileDialog').addEventListener('close', async () => {
    if ($('editProfileDialog').returnValue !== 'confirm' || !activeProfile) return;
    const r = await api(`/api/profiles/${encodeURIComponent(activeProfile.id)}`, {
      method: 'PATCH',
      body: {
        name: $('edProfName').value,
        language: $('edProfLang').value,
        baseCurrency: $('edProfCur').value,
        resetCurrencyPresets: $('edProfResetPresets').checked,
      },
    });
    if (r.ok) { await hydrateActiveWorkspace(); showToast('Profile updated'); }
  });
  const triggerBackupDownload = () => {
    if (!activeProfile) return;
    window.location.href = `/api/profiles/${encodeURIComponent(activeProfile.id)}/backup`;
    showToast('Downloading .stbackup file');
  };
  $('popBackupBtn').addEventListener('click', () => { toggleProfilePopover(false); triggerBackupDownload(); });
  $('setExportBakBtn').addEventListener('click', triggerBackupDownload);
  $('delProfBackupFirstBtn').addEventListener('click', triggerBackupDownload);
  const triggerBackupImport = () => { $('backupFileInput').value = ''; $('backupFileInput').click(); };
  $('popImportBtn').addEventListener('click', () => { toggleProfilePopover(false); triggerBackupImport(); });
  $('setImportBakBtn').addEventListener('click', triggerBackupImport);
  $('backupFileInput').addEventListener('change', async () => {
    const file = $('backupFileInput').files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const r = await api('/api/profiles/import', { method: 'POST', body: parsed });
      if (r.ok) { await hydrateActiveWorkspace(); showToast(`Imported ${r.data.profile.name}`); }
      else showToast('Invalid .stbackup file');
    } catch { showToast('Could not read backup file'); }
  });

  $('popDeleteBtn').addEventListener('click', () => {
    toggleProfilePopover(false);
    if (!activeProfile) return;
    $('delProfDesc').textContent = `Permanently deletes "${activeProfile.name}" and its local SQLite database. Export a backup first if you want to keep financial records.`;
    $('delProfConfirmInput').value = '';
    $('delProfConfirmBtn').disabled = true;
    $('deleteProfileDialog').showModal();
  });
  $('delProfConfirmInput').addEventListener('input', () => {
    $('delProfConfirmBtn').disabled = $('delProfConfirmInput').value.trim() !== (activeProfile?.name || '');
  });
  $('deleteProfileDialog').addEventListener('close', async () => {
    if ($('deleteProfileDialog').returnValue !== 'confirm' || !activeProfile) return;
    const r = await api(`/api/profiles/${encodeURIComponent(activeProfile.id)}`, { method: 'DELETE' });
    if (r.ok) { await hydrateActiveWorkspace(); showToast('Profile deleted'); }
  });

  // Home & Timer Actions
  const doToggle = () => sendTimerCommand({ type: snapshot && snapshot.state === 'running' ? 'pause' : 'resume' });
  $('toggleBtn').addEventListener('click', doToggle);
  $('homeToggleBtn').addEventListener('click', doToggle);
  $('homeAdd5Btn').addEventListener('click', () => sendTimerCommand({ type: 'add', amountMs: 300_000 }));
  $('homeCopyObsBtn').addEventListener('click', () => copyText(buildObsUrl(false), 'Copied OBS Browser Source URL'));
  $('homeQaRush').addEventListener('click', async () => {
    overlayCfg.rushOn = !overlayCfg.rushOn;
    await api('/api/overlay-config', { method: 'PUT', body: { rushOn: overlayCfg.rushOn } });
    loadHome();
    showToast(overlayCfg.rushOn ? 'Billing Rush ON' : 'Billing Rush OFF');
  });
  $('homeQaCycle').addEventListener('click', () => { switchView('finance'); document.querySelector('[data-fin-tab="sessions"]').click(); });
  $('homeQaExport').addEventListener('click', () => { finExportFromLedger = false; finExportScopeOverride = null; $('finExpDesc').textContent = 'Exporting current revenue session.'; $('finExportDialog').showModal(); });

  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => sendTimerCommand({ type: 'add', amountMs: Number(b.dataset.add) * 1000 })));
  document.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => sendTimerCommand({ type: 'subtract', amountMs: Number(b.dataset.sub) * 1000 })));
  $('setMinutesBtn').addEventListener('click', () => sendTimerCommand({ type: 'set', amountMs: Math.max(0, Math.round(Number($('setMinutesIn').value) || 0)) * 60_000 }));
  const readAdjMs = () => ((Number($('adjH').value) || 0) * 3600 + (Number($('adjM').value) || 0) * 60 + (Number($('adjS').value) || 0)) * 1000;
  $('adjAddBtn').addEventListener('click', () => sendTimerCommand({ type: 'add', amountMs: readAdjMs() }));
  $('adjSubBtn').addEventListener('click', () => sendTimerCommand({ type: 'subtract', amountMs: readAdjMs() }));
  $('adjSetBtn').addEventListener('click', () => sendTimerCommand({ type: 'set', amountMs: readAdjMs() }));
  $('resetTimerBtn').addEventListener('click', () => $('resetTimerDialog').showModal());
  $('resetTimerDialog').addEventListener('close', () => { if ($('resetTimerDialog').returnValue === 'confirm') sendTimerCommand({ type: 'reset' }); });
  $('resetAddedBtn').addEventListener('click', async () => { await api('/api/stats/reset-added', { method: 'POST' }); await loadDonations(); showToast('Reset Total Time Added to 0h 0m'); });

  // Donations
  $('donoSource').addEventListener('change', syncDonoFormMode);
  $('donoCurrency').addEventListener('change', syncDonoFormMode);
  $('donoSubmitBtn').addEventListener('click', async () => {
    const src = $('donoSource').value;
    const isYtMem = src === 'yt_member' || src === 'yt_gift_member';
    const isTwSub = src === 'twitch_sub' || src === 'twitch_gift_sub';
    const isUnits = src === 'yt_jewels' || src === 'twitch_bits';
    const isPrime = src === 'twitch_prime';
    const txType = (isYtMem || isTwSub || isUnits || isPrime) ? src : (src === 'SuperChat' ? 'yt_superchat' : 'cash_tip');
    const body = { provider: src, txType, gifterName: $('donoGifter').value, message: $('donoMessage').value };
    if (txType === 'cash_tip' || txType === 'yt_superchat') {
      body.amount = Number($('donoAmount').value);
      body.currency = $('donoCurrency').value || getCurrency();
    } else if (isYtMem) {
      body.levelName = $('donoYtLevel').value;
      body.quantity = Number($('donoYtQty').value) || 1;
    } else if (isTwSub) {
      body.tierKey = $('donoTwTier').value;
      body.quantity = Number($('donoTwQty').value) || 1;
    } else if (isUnits) {
      body.units = Number($('donoUnitsIn').value) || 100;
    }
    const r = await api('/api/donations/manual', { method: 'POST', body });
    if (r.ok) {
      $('donoGifter').value = '';
      $('donoMessage').value = '';
      await link?.refresh();
      await loadDonations();
      showToast(r.data.creditMs > 0 ? `Added +${fmtDuration(r.data.creditMs)}` : 'Recorded (timer unchanged)');
    }
  });
  $('donoSearch').addEventListener('input', renderDonationsTable);
  $('donoSort').addEventListener('change', renderDonationsTable);
  $('donoRefreshBtn').addEventListener('click', loadDonations);
  $('donoSelectBtn').addEventListener('click', () => { donoSelectMode = true; renderDonationsTable(); });
  $('donoSelDoneBtn').addEventListener('click', () => { donoSelectMode = false; donoSelected.clear(); renderDonationsTable(); });
  $('donoSelectAll').addEventListener('change', () => {
    if ($('donoSelectAll').checked) donations.forEach((d) => donoSelected.add(d.eventId));
    else donoSelected.clear();
    renderDonationsTable();
  });
  $('donoDelSelBtn').addEventListener('click', async () => {
    const r = await api('/api/donations/delete', { method: 'POST', body: { eventIds: [...donoSelected], subtractFromTimer: false } });
    if (r.ok) { donoSelected.clear(); donoSelectMode = false; await loadDonations(); showToast(`Removed ${r.data.deletedCount} item(s)`); }
  });
  $('donoBody').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-dono]');
    if (del) {
      await api('/api/donations/delete', { method: 'POST', body: { eventIds: [del.dataset.delDono], subtractFromTimer: false } });
      await loadDonations();
      showToast('Removed donation');
      return;
    }
    const cb = e.target.closest('[data-sel-dono]');
    if (cb) {
      if (cb.checked) donoSelected.add(cb.dataset.selDono);
      else donoSelected.delete(cb.dataset.selDono);
      renderDonationsTable();
    }
  });

  // Finance
  $('finScopeSel').addEventListener('change', () => { finScope = $('finScopeSel').value; $('finLdSess').value = finScope; loadFinance(); });
  $('finNewSessBtn').addEventListener('click', () => { document.querySelector('[data-fin-tab="sessions"]').click(); });
  $('finStartCycleBtn').addEventListener('click', async () => {
    const r = await api('/api/finance/sessions/reset', {
      method: 'POST',
      body: {
        closingLabel: $('finCloseLbl').value,
        nextLabel: $('finNextLbl').value,
        nextNotes: $('finNextNotes').value,
        alsoResetAdded: $('finAlsoAdded').checked,
      },
    });
    if (r.ok) {
      finScope = 'current';
      $('finCloseLbl').value = ''; $('finNextLbl').value = ''; $('finNextNotes').value = ''; $('finAlsoAdded').checked = false;
      await loadFinance();
      showToast(`Started ${r.data.activeSession.label} from 0`);
    }
  });
  $('finExportBtn').addEventListener('click', () => { finExportScopeOverride = null; finExportFromLedger = false; $('finExpDesc').textContent = `Exporting "${finData?.overview?.scope?.label || 'Current'}"`; $('finExportDialog').showModal(); });
  $('finLdExpBtn').addEventListener('click', () => { finExportScopeOverride = null; finExportFromLedger = true; $('finExpDesc').textContent = `Exporting ${finData?.ledger?.totalMatched || 0} filtered transactions.`; $('finExportDialog').showModal(); });
  document.querySelectorAll('[data-exp-fmt]').forEach((b) => b.addEventListener('click', () => { $('finExportDialog').close(); doFinanceExport(b.dataset.expFmt); }));
  document.querySelectorAll('[data-quick-exp]').forEach((b) => b.addEventListener('click', () => { finExportScopeOverride = null; finExportFromLedger = false; doFinanceExport(b.dataset.quickExp); }));

  [$('finSearch'), $('finMinGross')].forEach((i) => i.addEventListener('input', loadFinance));
  [$('finLdSess'), $('finLdChan'), $('finLdCur'), $('finFromDt'), $('finToDt'), $('finSort'), $('finIncDel')].forEach((i) => i.addEventListener('change', loadFinance));
  $('finClearBtn').addEventListener('click', () => {
    $('finSearch').value = ''; $('finLdChan').value = 'all'; $('finLdCur').value = 'all';
    $('finFromDt').value = ''; $('finToDt').value = ''; $('finMinGross').value = ''; $('finSort').value = 'latest'; $('finIncDel').checked = false;
    loadFinance();
  });
  $('finLdBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-inspect-tx]');
    if (btn) { openTxInspector(btn.dataset.inspectTx); return; }
    const tr = e.target.closest('tr[data-tx-id]');
    if (tr) openTxInspector(tr.dataset.txId);
  });
  $('finDetCopyBtn').addEventListener('click', () => copyText(finInspectEventId, 'Copied Event ID'));
  $('finSessList').addEventListener('click', (e) => {
    const o = e.target.closest('[data-open-sess]');
    if (o) { $('finLdSess').value = o.dataset.openSess; document.querySelector('[data-fin-tab="ledger"]').click(); loadFinance(); return; }
    const x = e.target.closest('[data-exp-sess]');
    if (x) { finExportScopeOverride = x.dataset.expSess; finExportFromLedger = false; $('finExpDesc').textContent = 'Exporting archived revenue cycle.'; $('finExportDialog').showModal(); }
  });
  $('finFeeMatrix').addEventListener('input', updateFinFormulaSim);
  [$('finTaxPct'), $('finTaxBasis'), $('finSimChan'), $('finSimAmt')].forEach((c) => { c.addEventListener('input', updateFinFormulaSim); c.addEventListener('change', updateFinFormulaSim); });
  $('finSaveFeesBtn').addEventListener('click', async () => {
    const r = await api('/api/finance/config', { method: 'PUT', body: readFinFeeControls() });
    if (r.ok) { await loadFinance(); showToast('Saved financial fee rules'); }
  });
  $('finRecalcBtn').addEventListener('click', async () => {
    const r = await api('/api/finance/recalculate', { method: 'POST', body: { scope: 'current' } });
    if (r.ok) { await loadFinance(); showToast(`Recalculated ${r.data.updatedCount} active transaction(s)`); }
  });

  // Rules & Catalogs
  $('addTierBtn').addEventListener('click', () => {
    const min = Number($('newTierMin').value);
    const ms = ((Number($('newTierH').value) || 0) * 3600 + (Number($('newTierM').value) || 0) * 60 + (Number($('newTierS').value) || 0)) * 1000;
    if (min > 0 && ms > 0) {
      draftRules.tiers = draftRules.tiers.filter((x) => x.minimumAmount !== min);
      draftRules.tiers.push({ minimumAmount: min, creditMs: ms });
      draftRules.tiers.sort((a, b) => b.minimumAmount - a.minimumAmount);
      renderRulesUi();
    }
  });
  $('rulesTierList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm-tier]');
    if (b && draftRules.tiers.length > 1) {
      draftRules.tiers = draftRules.tiers.filter((x) => x.minimumAmount !== Number(b.dataset.rmTier));
      renderRulesUi();
    }
  });
  $('saveRulesBtn').addEventListener('click', () => saveRulesToServer('Saved donation tiers'));
  $('saveTriggersBtn').addEventListener('click', () => saveRulesToServer('Saved timer triggers'));
  $('ytAddLvlBtn').addEventListener('click', () => {
    const name = $('ytNewName').value.trim();
    const price = Number($('ytNewPrice').value);
    if (!name || !Number.isFinite(price)) return;
    draftRules.eventRules.ytLevels.push({
      id: `yt-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name, price, creditMode: $('ytNewMode').value, fixedMs: (Number($('ytNewMin').value) || 10) * 60000, isDefault: false,
    });
    $('ytNewName').value = ''; $('ytNewPrice').value = '';
    renderCatalogsUi();
  });
  $('ytLevelsList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm-yt]');
    if (b && draftRules.eventRules.ytLevels.length > 1) {
      draftRules.eventRules.ytLevels = draftRules.eventRules.ytLevels.filter((x) => x.name !== b.dataset.rmYt);
      renderCatalogsUi();
    }
  });
  $('saveYtBtn').addEventListener('click', () => saveRulesToServer('Saved YouTube catalog'));
  $('saveTwBtn').addEventListener('click', () => saveRulesToServer('Saved Twitch catalog'));

  // OBS Overlay
  [$('ovTimerName'), $('ovTotalName'), $('ovBg'), $('ovPos'), $('ovSize'), $('ovOpacity'), $('ovShowTotal'), $('ovPopup')].forEach((c) => {
    c.addEventListener('input', applyObsPreview);
    c.addEventListener('change', applyObsPreview);
  });
  $('obsCopyBtn').addEventListener('click', () => copyText(buildObsUrl(false), 'Copied OBS Browser Source URL'));
  $('obsRevealBtn').addEventListener('click', () => { obsRevealed = !obsRevealed; applyObsPreview(); });
  $('obsRushBtn').addEventListener('click', async () => {
    overlayCfg.rushOn = !overlayCfg.rushOn;
    await api('/api/overlay-config', { method: 'PUT', body: { rushOn: overlayCfg.rushOn } });
    applyObsPreview();
    showToast(overlayCfg.rushOn ? 'Billing Rush active' : 'Billing Rush stopped');
  });
  $('ovSaveBtn').addEventListener('click', async () => {
    const r = await api('/api/overlay-config', {
      method: 'PUT',
      body: {
        timerName: $('ovTimerName').value, totalName: $('ovTotalName').value,
        bgMode: $('ovBg').value, position: $('ovPos').value,
        fontSize: Number($('ovSize').value) || 38, opacity: Number($('ovOpacity').value) || 92,
        showTotal: $('ovShowTotal').checked, popup: $('ovPopup').checked,
      },
    });
    if (r.ok) showToast('Saved OBS overlay style');
  });

  // Tunnel & Webhooks & Simulator
  $('tunnelStartBtn').addEventListener('click', async () => {
    $('tunnelStartBtn').disabled = true;
    showToast('Starting Cloudflare Quick Tunnel…');
    const r = await api('/api/tunnel/start', { method: 'POST' });
    $('tunnelStartBtn').disabled = false;
    await loadIntegrations();
    showToast(r.data?.publicUrl ? `Tunnel live: ${r.data.publicUrl}` : (r.data?.lastError || 'Tunnel error'));
  });
  $('tunnelCustomBtn').addEventListener('click', async () => {
    await api('/api/tunnel/custom', { method: 'POST', body: { url: $('tunnelUrlInput').value } });
    await loadIntegrations();
    showToast('Updated public webhook URL');
  });
  $('tunnelStopBtn').addEventListener('click', async () => {
    await api('/api/tunnel/stop', { method: 'POST' });
    await loadIntegrations();
    showToast('Tunnel stopped');
  });
  $('webhookCardsGrid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy-url]');
    if (b) { copyText(b.dataset.copyUrl, 'Copied webhook URL'); return; }
    const tb = e.target.closest('[data-quick-wh-test]');
    if (tb) {
      const prov = tb.dataset.quickWhTest;
      const meta = (bootData?.platforms || []).find((p) => p.id === prov);
      const cur = meta?.defaultCurrency || getCurrency();
      const amt = cur === 'IDR' ? 25000 : (cur === 'KRW' ? 5000 : (cur === 'JPY' ? 500 : (cur === 'TWD' ? 100 : 10)));
      const r = await api('/api/webhooks/test', {
        method: 'POST',
        body: { provider: prov, gifterName: `${meta?.name || prov} Tester`, amount: amt, currency: cur },
      });
      if (r.ok) {
        await link?.refresh();
        await loadIntegrations();
        showToast(`${meta?.name || prov} test applied (+${fmtDuration(r.data.creditMs)})`);
      } else {
        showToast(`Test failed: ${r.data?.error || r.status}`);
      }
    }
  });
  $('simSlBtn').addEventListener('click', async () => {
    const r = await api('/api/integrations/streamlabs/test', {
      method: 'POST',
      body: { eventType: $('simSlType').value, gifterName: $('simSlName').value, amount: Number($('simSlAmt').value), currency: $('simSlCur').value },
    });
    if (r.ok) { await link?.refresh(); await loadDonations(); showToast(`Streamlabs event applied (+${fmtDuration(r.data.creditMs)})`); }
  });
  $('simWhBtn').addEventListener('click', async () => {
    const r = await api('/api/webhooks/test', {
      method: 'POST',
      body: { provider: $('simWhProv').value, gifterName: $('simWhName').value, amount: Number($('simWhAmt').value), currency: $('simWhCur').value },
    });
    if (r.ok) { await link?.refresh(); await loadDonations(); showToast(`Webhook (${r.data.provider}) applied (+${fmtDuration(r.data.creditMs)})`); }
  });

  // FX & Desktop Preferences
  $('fxNowBtn').addEventListener('click', async () => {
    $('fxNowBtn').disabled = true;
    const r = await api('/api/fx/refresh', { method: 'POST' });
    $('fxNowBtn').disabled = false;
    if (r.ok) {
      bootData.fx = r.data.fx;
      renderFxRatesList();
      showToast(`Updated ${r.data.currencyCount} live rates (${r.data.provider})`);
    } else showToast('FX update failed');
  });
  $('fxSaveBtn').addEventListener('click', async () => {
    const r = await api('/api/fx', { method: 'PUT', body: { autoUpdate: $('fxAutoChk').checked, intervalHours: Number($('fxIntSel').value) } });
    if (r.ok) { bootData.fx = r.data.fx; renderFxRatesList(); showToast('Saved FX settings'); }
  });
  $('fxSearchIn').addEventListener('input', renderFxRatesList);
  $('saveDesktopBtn').addEventListener('click', async () => {
    const nextLang = $('setLangSelect').value;
    if (activeProfile && nextLang !== activeProfile.language) {
      await api(`/api/profiles/${encodeURIComponent(activeProfile.id)}`, { method: 'PATCH', body: { language: nextLang } });
      activeProfile.language = nextLang;
      setLanguage(nextLang);
    }
    const hotkeys = { toggle: $('hkToggle').value, add1m: $('hkAdd1').value, add5m: $('hkAdd5').value };
    const closeToTray = Boolean($('setCloseToTrayChk').checked);
    await api('/api/app/settings', { method: 'PUT', body: { hotkeys, closeToTray } });
    if (bootData) bootData.closeToTray = closeToTray;
    if (window.__TAURI_INTERNALS__?.invoke) {
      window.__TAURI_INTERNALS__.invoke('update_hotkeys', { hotkeys }).catch(() => {});
    }
    renderProfileHeaderAndMenu();
    showToast('Saved desktop preferences');
  });

  // Built-in Software Update actions (clean Apple toggles — zero GitHub URL exposed)
  $('popUpdateBtn').addEventListener('click', () => {
    toggleProfilePopover(false);
    switchView('settings');
    document.querySelector('[data-set-tab="desktop"]')?.click();
    loadUpdateStatus();
  });
  const saveAutoUpdatePrefs = async () => {
    const r = await api('/api/updates/config', {
      method: 'PUT',
      body: {
        autoCheck: $('updAutoCheckChk').checked,
        autoInstall: $('updAutoInstallChk').checked,
      },
    });
    if (r.ok) { renderUpdateStatus(r.data.updates); showToast('Updated auto-update preferences'); }
  };
  $('updAutoCheckChk').addEventListener('change', saveAutoUpdatePrefs);
  $('updAutoInstallChk').addEventListener('change', saveAutoUpdatePrefs);
  $('updCheckBtn').addEventListener('click', async () => {
    $('updCheckBtn').disabled = true;
    const r = await api('/api/updates/check', { method: 'POST', body: {} });
    $('updCheckBtn').disabled = false;
    if (r.ok && r.data?.updates) {
      renderUpdateStatus(r.data.updates);
      const st = r.data.updates.status;
      showToast(st === 'update_available' ? `Update v${r.data.updates.latestVersion} available!` : (st === 'up_to_date' ? 'Stream Timer is up to date' : (r.data.updates.lastError || 'Check complete')));
    }
  });
  $('updInstallBtn').addEventListener('click', async () => {
    const stRes = await api('/api/updates/status');
    if (stRes.ok && stRes.data?.isTimerRunning) {
      showToast('Timer is currently running — pause the timer first before installing the update.');
      return;
    }
    $('updInstallBtn').disabled = true;
    $('updCheckBtn').disabled = true;
    const prevLbl = $('updInstallBtn').textContent;
    $('updInstallBtn').textContent = 'Downloading & Verifying…';
    showToast('Backing up profiles & verifying SHA-256 update…');
    const dl = await api('/api/updates/download', { method: 'POST' });
    if (!dl.ok) {
      $('updInstallBtn').disabled = false;
      $('updCheckBtn').disabled = false;
      $('updInstallBtn').textContent = prevLbl;
      if (dl.data?.status) renderUpdateStatus(dl.data.status);
      showToast(`Update failed: ${dl.data?.error || dl.status}`);
      return;
    }
    renderUpdateStatus(dl.data.status);
    if (window.__TAURI_INTERNALS__?.invoke && dl.data.status?.stagedPath) {
      $('updInstallBtn').textContent = 'Installing & Relaunching…';
      showToast('Applying update & relaunching…');
      window.__TAURI_INTERNALS__.invoke('apply_staged_update', { stagedPath: dl.data.status.stagedPath }).catch((err) => {
        $('updInstallBtn').disabled = false;
        $('updCheckBtn').disabled = false;
        showToast(`Install error: ${String(err)}`);
      });
    } else {
      $('updInstallBtn').disabled = false;
      $('updCheckBtn').disabled = false;
      showToast('Update verified & staged (run inside Stream Timer.exe to auto-relaunch)');
    }
  });
}

// -------------------------------------------------- Apple Intro Launch ------

async function boot() {
  initDesktopTitlebar();
  bindAllEvents();
  const startAt = performance.now();

  const res = await api('/api/app/bootstrap');
  if (res.ok) {
    bootData = res.data;
    applyAppearance(bootData.appearance || 'system');
  }

  // Keep splash silky & brief (instant handoff when coming from native Tauri boot screen)
  const fromBoot = new URLSearchParams(window.location.search).has('desktop');
  const minDwell = fromBoot ? 160 : 550;
  const elapsed = performance.now() - startAt;
  const remaining = Math.max(0, minDwell - elapsed);
  await new Promise((r) => setTimeout(r, remaining));

  if (!bootData || bootData.needsOnboarding) {
    openOnboarding({ addingAnother: false });
  } else {
    await hydrateActiveWorkspace();
  }

  // Smooth spring dissolve out of the Apple Splash screen
  const splash = $('appleSplash');
  splash.classList.add('is-leaving');
  setTimeout(() => { splash.hidden = true; }, 440);
}

boot();
