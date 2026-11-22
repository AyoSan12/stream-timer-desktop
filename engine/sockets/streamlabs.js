// Streamlabs Socket API (Engine.IO v3 / EIO=3) client, live token verifier,
// and dynamic-baseCurrency event normalizer.

import crypto from 'node:crypto';
import {
  normalizeTwitchPlanKey,
  resolveTransactionCredit,
} from '../domain.js';
import { BASELINE_RATES_PER_USD } from '../fx.js';

export const DEFAULT_STREAMLABS_FILTERS = {
  tips: true,
  superchat: true,
  ytMember: true,
  ytGiftMember: true,
  ytJewels: true,
  twitchSub: true,
  twitchBits: true,
};

export function sanitizeStreamlabsFilters(raw, base = DEFAULT_STREAMLABS_FILTERS) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const b = (k) => (typeof src[k] === 'boolean' ? src[k] : (base[k] !== false));
  return {
    tips: b('tips'),
    superchat: b('superchat'),
    ytMember: b('ytMember'),
    ytGiftMember: b('ytGiftMember'),
    ytJewels: b('ytJewels'),
    twitchSub: b('twitchSub'),
    twitchBits: b('twitchBits'),
  };
}

function safeIdToken(raw, fallbackObj) {
  const cleaned = typeof raw === 'string' || typeof raw === 'number'
    ? String(raw).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 96)
    : '';
  if (cleaned) return cleaned;
  return crypto.createHash('sha256').update(JSON.stringify(fallbackObj)).digest('hex').slice(0, 32);
}

function cleanStr(v, max, fb = '') {
  if (typeof v !== 'string') return fb;
  const s = v.trim().slice(0, max);
  return s || fb;
}

function parseDisplayNumber(disp) {
  if (typeof disp !== 'string') return NaN;
  const match = disp.match(/[0-9][0-9.,\s\u00a0]*/);
  if (!match) return NaN;
  let token = match[0].replace(/[\s\u00a0]/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(token)) {
    token = token.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+,\d{1,2}$/.test(token)) {
    token = token.replace(',', '.');
  } else {
    token = token.replace(/,/g, '');
  }
  const n = Number(token);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

const LOW_UNIT_CURRENCIES = new Set(['IDR', 'VND', 'KRW', 'JPY', 'CLP', 'COP', 'HUF', 'KZT', 'PYG', 'TWD', 'PHP', 'THB', 'INR', 'PKR', 'LKR', 'ARS']);

export function parseSuperchatAmount(item) {
  if (item.amountMicros !== undefined && Number.isFinite(Number(item.amountMicros))) {
    return Number(item.amountMicros) / 1_000_000;
  }
  const raw = Number(item.amount);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const disp = typeof item.displayString === 'string' ? item.displayString : '';
  const parsedDisp = parseDisplayNumber(disp);
  if (Number.isFinite(parsedDisp) && parsedDisp > 0) {
    return raw >= parsedDisp * 500_000 ? raw / 1_000_000 : raw;
  }
  const cur = String(item.currency || 'USD').trim().toUpperCase();
  if (!LOW_UNIT_CURRENCIES.has(cur) && raw >= 100_000) return raw / 1_000_000;
  return raw;
}

export function normalizeStreamlabsEvent(
  eventData,
  rulesConfig,
  fxState = { ratesPerUsd: BASELINE_RATES_PER_USD },
  rawFilters = DEFAULT_STREAMLABS_FILTERS,
) {
  if (!eventData || typeof eventData !== 'object') return [];
  const type = String(eventData.type || '').trim();
  const origin = String(eventData.for || '').trim().toLowerCase();
  const messages = Array.isArray(eventData.message)
    ? eventData.message
    : (eventData.message && typeof eventData.message === 'object' ? [eventData.message] : []);
  if (!type || messages.length === 0) return [];

  const filters = sanitizeStreamlabsFilters(rawFilters);
  const baseCur = rulesConfig.baseCurrency || 'USD';
  const out = [];

  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    if (item.isTest === true && eventData._allowTest !== true) continue;

    const gifterName = cleanStr(item.gifter || item.name || item.from || item.displayName, 120, 'Anonymous');
    const message = cleanStr(item.message || item.comment || '', 500, '');
    const idSeed = item._id ?? item.id ?? item.event_id ?? item.donation_id;

    // 1. Streamlabs Direct Tips
    if ((!origin || origin === 'streamlabs') && type === 'donation') {
      if (!filters.tips) continue;
      const rawAmount = Number(item.amount);
      if (!Number.isFinite(rawAmount) || rawAmount <= 0) continue;
      const currency = cleanStr(item.currency, 8, 'USD').toUpperCase();
      const res = resolveTransactionCredit({ kind: 'cash_tip', amount: rawAmount, currency }, rulesConfig, fxState);
      out.push({
        eventId: `sl-tip-${safeIdToken(idSeed, { type, gifterName, rawAmount, currency, message })}`,
        provider: 'streamlabs',
        grossAmount: res.grossAmount,
        currency: baseCur,
        creditMs: res.creditMs,
        payload: { gifterName, message, originalAmount: rawAmount, originalCurrency: currency, txType: 'cash_tip', streamlabsType: type },
      });
      continue;
    }

    // 2. YouTube Super Chat & Super Stickers
    if (origin === 'youtube_account' && (type === 'superchat' || type === 'supersticker')) {
      if (!filters.superchat) continue;
      const rawAmount = parseSuperchatAmount(item);
      if (!Number.isFinite(rawAmount) || rawAmount <= 0) continue;
      const currency = cleanStr(item.currency, 8, 'USD').toUpperCase();
      const res = resolveTransactionCredit({ kind: 'yt_superchat', amount: rawAmount, currency }, rulesConfig, fxState);
      const isSticker = Boolean(item.isSuperStickerEvent || type === 'supersticker');
      out.push({
        eventId: `sl-ytsc-${safeIdToken(idSeed, { type, gifterName, rawAmount, currency, message })}`,
        provider: isSticker ? 'yt-supersticker' : 'yt-superchat',
        grossAmount: res.grossAmount,
        currency: baseCur,
        creditMs: res.creditMs,
        payload: { gifterName, message, originalAmount: rawAmount, originalCurrency: currency, txType: 'yt_superchat', streamlabsType: type },
      });
      continue;
    }

    // 3. YouTube Gift Membership (ignore per-recipient duplicates)
    if (origin === 'youtube_account' && (type === 'giftMembershipReceived' || type === 'giftMembershipReceivedEvent')) {
      continue;
    }
    if (origin === 'youtube_account' && (type === 'membershipGift' || type === 'membershipGifting' || type === 'membershipGiftingEvent')) {
      if (!filters.ytGiftMember) continue;
      const count = Math.max(1, Math.trunc(Number(item.giftMembershipsCount ?? item.count ?? item.amount ?? 1) || 1));
      const levelName = cleanStr(item.membershipLevelName || item.giftMembershipsLevelName || item.levelName || item.sub_plan_name, 60, '');
      const res = resolveTransactionCredit({ kind: 'yt_gift_member', levelName, quantity: count }, rulesConfig, fxState);
      out.push({
        eventId: `sl-ytgift-${safeIdToken(idSeed, { type, gifterName, count, levelName })}`,
        provider: 'yt-gift-member',
        grossAmount: res.grossAmount,
        currency: baseCur,
        creditMs: res.creditMs,
        payload: {
          gifterName,
          message: message || `Gifted ${count}× ${res.resolvedLabel}`,
          units: count,
          tierOrLevel: res.resolvedLabel,
          rawLevelName: res.rawLevelName,
          matchStatus: res.matchStatus,
          matchedLevelId: res.matchedLevelId,
          fallbackLevelName: res.fallbackLevelName,
          txType: 'yt_gift_member',
          streamlabsType: type,
        },
      });
      continue;
    }

    // 4. YouTube Individual Membership
    if (origin === 'youtube_account' && (type === 'subscription' || type === 'sponsor')) {
      if (!filters.ytMember) continue;
      const levelName = cleanStr(item.membershipLevelName || item.levelName || item.sub_plan_name || item.tier, 60, '');
      const res = resolveTransactionCredit({ kind: 'yt_member', levelName, quantity: 1 }, rulesConfig, fxState);
      out.push({
        eventId: `sl-ytmem-${safeIdToken(idSeed, { type, gifterName, levelName, months: item.months ?? 1 })}`,
        provider: 'yt-membership',
        grossAmount: res.grossAmount,
        currency: baseCur,
        creditMs: res.creditMs,
        payload: {
          gifterName,
          message: message || `YouTube Member (${res.resolvedLabel})`,
          units: 1,
          tierOrLevel: res.resolvedLabel,
          rawLevelName: res.rawLevelName,
          matchStatus: res.matchStatus,
          matchedLevelId: res.matchedLevelId,
          fallbackLevelName: res.fallbackLevelName,
          txType: 'yt_member',
          streamlabsType: type,
        },
      });
      continue;
    }

    // 5. YouTube Virtual Gifts / Jewels
    const lowerType = type.toLowerCase();
    if ((origin === 'youtube_account' || !origin) && (lowerType === 'jewels' || lowerType === 'jewelsgifted' || lowerType === 'gift' || lowerType === 'giftevent' || lowerType === 'youtube_gift')) {
      if (!filters.ytJewels) continue;
      const jewels = Math.max(0, Math.trunc(Number(item.jewels ?? item.jewelCount ?? item.amount ?? 0)));
      if (jewels <= 0) continue;
      const res = resolveTransactionCredit({ kind: 'yt_jewels', units: jewels }, rulesConfig, fxState);
      out.push({
        eventId: `sl-ytjewel-${safeIdToken(idSeed, { type, gifterName, jewels })}`,
        provider: 'yt-jewels',
        grossAmount: res.grossAmount,
        currency: baseCur,
        creditMs: res.creditMs,
        payload: { gifterName, message: message || `${jewels} YouTube Jewels`, units: jewels, tierOrLevel: `${jewels} jewels`, txType: 'yt_jewels', streamlabsType: type },
      });
      continue;
    }

    // 6. Twitch Subscriptions, Prime, Gift Subs
    if (origin === 'twitch_account' && (type === 'subscription' || type === 'resub' || type === 'subMysteryGift')) {
      if (!filters.twitchSub) continue;
      if (item.is_mystery_gift === true && type !== 'subMysteryGift') continue;
      const subType = String(item.sub_type || '').toLowerCase();
      const planKey = normalizeTwitchPlanKey(item.sub_plan ?? item.subPlan ?? '1000');
      const isGift = type === 'subMysteryGift' || subType === 'subgift' || subType === 'anonsubgift';
      const isPrime = !isGift && planKey === 'prime';
      const count = isGift ? Math.max(1, Math.trunc(Number(item.amount ?? item.count ?? 1) || 1)) : 1;
      const kind = isGift ? 'twitch_gift_sub' : (isPrime ? 'twitch_prime' : 'twitch_sub');
      const res = resolveTransactionCredit({ kind, tierKey: planKey, quantity: count }, rulesConfig, fxState);
      const provider = isGift ? 'twitch-gift-sub' : (isPrime ? 'twitch-prime' : 'twitch-sub');
      out.push({
        eventId: `sl-twsub-${safeIdToken(idSeed, { type, gifterName, count, planKey, isGift })}`,
        provider,
        grossAmount: res.grossAmount,
        currency: baseCur,
        creditMs: res.creditMs,
        payload: { gifterName, message: message || (isGift ? `Gifted ${count}× Twitch ${res.resolvedLabel}` : `Twitch ${res.resolvedLabel}`), units: count, tierOrLevel: res.resolvedLabel, txType: kind, streamlabsType: type },
      });
      continue;
    }

    // 7. Twitch Bits
    if (origin === 'twitch_account' && type === 'bits') {
      if (!filters.twitchBits) continue;
      const bits = Math.max(0, Math.trunc(Number(item.amount ?? item.bits ?? 0)));
      if (bits <= 0) continue;
      const res = resolveTransactionCredit({ kind: 'twitch_bits', units: bits }, rulesConfig, fxState);
      out.push({
        eventId: `sl-twbits-${safeIdToken(idSeed, { type, gifterName, bits, message })}`,
        provider: 'twitch-bits',
        grossAmount: res.grossAmount,
        currency: baseCur,
        creditMs: res.creditMs,
        payload: { gifterName, message: message || `${bits} Twitch Bits`, units: bits, tierOrLevel: `${bits} bits`, txType: 'twitch_bits', streamlabsType: type },
      });
    }
  }
  return out;
}

export function buildSyntheticStreamlabsEvent({ eventType, gifterName, amount, currency, tierKey, levelName, opId }) {
  const name = cleanStr(gifterName, 120, 'Streamlabs Tester');
  const id = safeIdToken(opId, { eventType, name, amount, tierKey, levelName, ts: Date.now() });
  const num = Number(amount);
  const plan = normalizeTwitchPlanKey(tierKey || '1000');
  const planRaw = plan === 'prime' ? 'Prime' : plan;

  switch (eventType) {
    case 'superchat':
      return { _allowTest: true, type: 'superchat', for: 'youtube_account', message: [{ id, name, amount: Number.isFinite(num) && num > 0 ? num : 5, currency: currency || 'USD', comment: 'Test YouTube Super Chat' }] };
    case 'yt_member':
      return { _allowTest: true, type: 'subscription', for: 'youtube_account', message: [{ id, name, months: 1, membershipLevelName: levelName !== undefined && levelName !== null ? String(levelName) : 'Supporter', message: 'Test YouTube Membership' }] };
    case 'yt_gift_member':
      return { _allowTest: true, type: 'membershipGift', for: 'youtube_account', message: [{ id, name, giftMembershipsCount: Math.max(1, Math.trunc(num || 1)), membershipLevelName: levelName !== undefined && levelName !== null ? String(levelName) : 'Supporter', message: 'Test YouTube Gift Membership' }] };
    case 'yt_jewels':
      return { _allowTest: true, type: 'JewelsGifted', for: 'youtube_account', message: [{ id, name, jewels: Math.max(1, Math.trunc(num || 100)), message: 'Test YouTube Jewels' }] };
    case 'twitch_prime':
      return { _allowTest: true, type: 'subscription', for: 'twitch_account', message: [{ id, name, sub_plan: 'Prime', sub_type: 'sub', months: 1, message: 'Test Twitch Prime Sub' }] };
    case 'twitch_sub_individual':
      return { _allowTest: true, type: 'subscription', for: 'twitch_account', message: [{ id, name, sub_plan: planRaw, sub_type: 'sub', months: 1, message: 'Test Twitch Sub' }] };
    case 'twitch_gift_sub':
      return { _allowTest: true, type: 'subMysteryGift', for: 'twitch_account', message: [{ id, name, gifter: name, sub_plan: planRaw === 'Prime' ? '1000' : planRaw, amount: Math.max(1, Math.trunc(num || 1)), message: 'Test Twitch Gift Sub' }] };
    case 'twitch_bits':
      return { _allowTest: true, type: 'bits', for: 'twitch_account', message: [{ id, name, amount: Math.max(1, Math.trunc(num || 100)), message: 'Test Twitch Bits' }] };
    case 'donation':
    default:
      return { _allowTest: true, type: 'donation', for: 'streamlabs', message: [{ id, name, amount: Number.isFinite(num) && num > 0 ? num : 5, currency: currency || 'USD', message: 'Test Streamlabs Tip' }] };
  }
}

/**
 * Verify a Streamlabs Socket API Token live via Engine.IO v3 handshake (used in Onboarding Step 3).
 */
export function verifyStreamlabsToken(socketToken, {
  socketBaseUrl = process.env.STREAMLABS_SOCKET_URL || 'wss://sockets.streamlabs.com',
  timeoutMs = 7000,
} = {}) {
  const token = typeof socketToken === 'string' ? socketToken.trim() : '';
  if (!token || token.length < 10) {
    return Promise.resolve({ ok: false, error: 'Token looks too short, paste your full Streamlabs Socket API Token.' });
  }
  if (typeof WebSocket !== 'function') {
    return Promise.resolve({ ok: false, error: 'WebSocket runtime unavailable' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let ws = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws) { try { ws.close(); } catch { /* ignore */ } }
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'Connection timed out, check token or internet access' }), timeoutMs);

    try {
      const base = socketBaseUrl.replace(/\/+$/, '');
      const url = `${base}/socket.io/?token=${encodeURIComponent(token)}&EIO=3&transport=websocket`;
      ws = new WebSocket(url);
      ws.addEventListener('message', (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (raw === '40' || raw.startsWith('40')) {
          done({ ok: true, message: 'Verified live Engine.IO v3 handshake with Streamlabs' });
        } else if (raw.startsWith('44')) {
          done({ ok: false, error: 'Streamlabs rejected this Socket API Token' });
        }
      });
      ws.addEventListener('error', () => done({ ok: false, error: 'Could not reach sockets.streamlabs.com' }));
      ws.addEventListener('close', (ev) => {
        if (!settled) done({ ok: false, error: `Streamlabs closed connection (code ${ev.code}), invalid token` });
      });
    } catch (err) {
      done({ ok: false, error: String(err && err.message || err) });
    }
  });
}

export function createStreamlabsClient({
  onEvent,
  logger = () => {},
  socketBaseUrl = process.env.STREAMLABS_SOCKET_URL || 'wss://sockets.streamlabs.com',
} = {}) {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let config = { enabled: false, socketToken: '', filters: { ...DEFAULT_STREAMLABS_FILTERS } };
  let state = { status: 'disconnected', lastConnectedAtMs: null, lastEventAtMs: null, lastError: null, eventsReceived: 0 };

  function clearTimers() {
    if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function closeSocket() {
    clearTimers();
    if (ws) {
      const ref = ws;
      ws = null;
      try { ref.close(); } catch { /* ignore */ }
    }
  }

  function scheduleReconnect() {
    if (!config.enabled || !config.socketToken) return;
    clearTimers();
    reconnectAttempt += 1;
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(reconnectAttempt - 1, 5)));
    state.status = 'reconnecting';
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function handleMessage(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return;
    if (raw.startsWith('0')) {
      try {
        const hs = JSON.parse(raw.slice(1));
        const pingMs = Math.max(5_000, Math.min(60_000, Number(hs.pingInterval) || 25_000));
        if (pingTimer !== null) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send('2'); } catch { /* ignore */ }
          }
        }, pingMs);
        if (typeof pingTimer.unref === 'function') pingTimer.unref();
      } catch { /* ignore */ }
      return;
    }
    if (raw === '40' || raw.startsWith('40')) {
      reconnectAttempt = 0;
      state.status = 'connected';
      state.lastConnectedAtMs = Date.now();
      state.lastError = null;
      logger('streamlabs_connected');
      return;
    }
    if (raw === '44' || raw.startsWith('44')) {
      state.status = 'error';
      state.lastError = 'Invalid Streamlabs Socket API token';
      return;
    }
    if (raw.startsWith('42')) {
      try {
        const packet = JSON.parse(raw.slice(2));
        if (Array.isArray(packet) && packet[0] === 'event' && packet[1]) {
          state.lastEventAtMs = Date.now();
          state.eventsReceived += 1;
          if (typeof onEvent === 'function') {
            Promise.resolve(onEvent(packet[1], config.filters)).catch((err) => {
              logger('streamlabs_event_error', { message: String(err && err.message) });
            });
          }
        }
      } catch { /* ignore */ }
    }
  }

  function connect() {
    closeSocket();
    if (!config.enabled || !config.socketToken) { state.status = 'disconnected'; return; }
    if (typeof WebSocket !== 'function') { state.status = 'error'; state.lastError = 'WebSocket unavailable'; return; }
    state.status = 'connecting';
    state.lastError = null;
    try {
      const base = socketBaseUrl.replace(/\/+$/, '');
      const sock = new WebSocket(`${base}/socket.io/?token=${encodeURIComponent(config.socketToken)}&EIO=3&transport=websocket`);
      ws = sock;
      sock.addEventListener('message', (ev) => { if (sock === ws) handleMessage(typeof ev.data === 'string' ? ev.data : ''); });
      sock.addEventListener('error', () => { if (sock === ws) { state.lastError = 'WebSocket connection error'; state.status = 'error'; } });
      sock.addEventListener('close', () => { if (sock === ws) { ws = null; clearTimers(); if (config.enabled && config.socketToken) scheduleReconnect(); else state.status = 'disconnected'; } });
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
      scheduleReconnect();
    }
  }

  function configure(next) {
    const prevToken = config.socketToken;
    const prevEnabled = config.enabled;
    config = {
      enabled: Boolean(next.enabled),
      socketToken: typeof next.socketToken === 'string' ? next.socketToken.trim() : '',
      filters: sanitizeStreamlabsFilters(next.filters, config.filters),
    };
    if (!config.enabled || !config.socketToken) {
      closeSocket();
      state.status = 'disconnected';
      state.lastError = null;
    } else if (config.socketToken !== prevToken || !prevEnabled || state.status === 'disconnected' || state.status === 'error') {
      reconnectAttempt = 0;
      connect();
    }
    return getStatus();
  }

  function stop() {
    config.enabled = false;
    closeSocket();
    state.status = 'disconnected';
  }

  function getStatus() {
    return {
      enabled: config.enabled,
      hasToken: Boolean(config.socketToken),
      status: state.status,
      lastConnectedAtMs: state.lastConnectedAtMs,
      lastEventAtMs: state.lastEventAtMs,
      lastError: state.lastError,
      eventsReceived: state.eventsReceived,
      filters: { ...config.filters },
    };
  }

  return { configure, stop, getStatus };
}
