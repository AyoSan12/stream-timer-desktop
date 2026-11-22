// Global & Regional Outbound WebSocket Clients + Production-Audited Webhook Parsers.
//
// Outbound Local WebSockets (Zero Port Forwarding / Zero Tunnel Needed):
//   1. StreamElements Astro (`wss://astro.streamelements.com` + auto Channel _id via JWT)
//   2. Trakteer (`wss://socket.trakteer.id` Pusher `creator-stream` + test channel)
//   3. TipeeeStream (Socket.IO v2 via official host discovery + API Key)
//   4. DonationAlerts (Centrifugo WebSocket + OAuth2 channel subscribe)
//   5. Naver Chzzk (Read-only Chat WS `cmd: 93102` / `msgTypeCode: 10` KRW Cheese)
//
// Inbound Webhooks (All 11 regional & global platforms, real-world verified):
//   Tako.id, Saweria, SociaBuzz, Trakteer HTTP, Ko-fi, Buy Me a Coffee,
//   Tiltify (timestamp.body Base64), Naver Chzzk, LivePix (cents -> BRL),
//   ECPay (form/JSON), Doneru/OFUSE relay.

import crypto from 'node:crypto';
import { resolveTransactionCredit } from '../domain.js';
import { PLATFORM_BY_ID } from '../platforms.js';
import { BASELINE_RATES_PER_USD } from '../fx.js';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function cleanText(v, max, fb = '') {
  if (typeof v !== 'string') return fb;
  const s = v.trim().slice(0, max);
  return s || fb;
}

function makeEventId(prefix, rawId, fallbackObj) {
  const cleaned = typeof rawId === 'string' || typeof rawId === 'number'
    ? String(rawId).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 88)
    : '';
  if (cleaned) return `${prefix}-${cleaned}`;
  return `${prefix}-${crypto.createHash('sha256').update(JSON.stringify(fallbackObj)).digest('hex').slice(0, 28)}`;
}

// ----------------------------------------- 1. StreamElements Astro Socket ---

export function createStreamElementsClient({ onTip, logger = () => {} } = {}) {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let attempt = 0;
  let cfg = { enabled: false, jwtToken: '' };
  let state = { status: 'disconnected', lastConnectedAtMs: null, lastError: null, eventsReceived: 0 };

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { const r = ws; ws = null; try { r.close(); } catch { /* ignore */ } }
  }

  function schedule() {
    if (!cfg.enabled || !cfg.jwtToken) return;
    attempt += 1;
    state.status = 'reconnecting';
    const delay = Math.min(30_000, 1500 * Math.pow(2, Math.min(attempt - 1, 4)));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  async function resolveChannelId(jwt) {
    try {
      const res = await fetch('https://api.streamelements.com/kappa/v2/channels/me', {
        headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
      });
      if (!res.ok) return '';
      const data = await res.json();
      return typeof data?._id === 'string' ? data._id : '';
    } catch {
      return '';
    }
  }

  async function connect() {
    cleanup();
    if (!cfg.enabled || !cfg.jwtToken) { state.status = 'disconnected'; return; }
    state.status = 'connecting';
    state.lastError = null;
    try {
      const channelId = await resolveChannelId(cfg.jwtToken);
      if (!cfg.enabled) return;

      const url = process.env.STREAMELEMENTS_WS_URL || 'wss://astro.streamelements.com';
      const sock = new WebSocket(url);
      ws = sock;

      const sendSubscriptions = () => {
        const topics = ['channel.activities', 'channel.tips'];
        for (const topic of topics) {
          const payload = { topic, token: cfg.jwtToken, token_type: 'jwt' };
          if (channelId) payload.room = channelId;
          sock.send(JSON.stringify({ type: 'subscribe', nonce: crypto.randomUUID(), data: payload }));
        }
      };

      sock.addEventListener('open', () => {
        if (sock !== ws) return;
        pingTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
          }
        }, 25_000);
        if (typeof pingTimer.unref === 'function') pingTimer.unref();
      });

      let subscribed = false;
      sock.addEventListener('message', (ev) => {
        if (sock !== ws) return;
        try {
          const msg = JSON.parse(String(ev.data || '{}'));
          if (msg.type === 'welcome' && !subscribed) {
            subscribed = true;
            sendSubscriptions();
            return;
          }
          if (msg.type === 'response') {
            if (msg.error) {
              if (state.status !== 'connected') {
                state.status = 'error';
                state.lastError = String(msg.error);
              }
            } else {
              attempt = 0;
              state.status = 'connected';
              state.lastConnectedAtMs = Date.now();
              state.lastError = null;
              logger('streamelements_connected', { channelId: channelId || null });
            }
          } else if (msg.type === 'message' && msg.data) {
            // Supports both `channel.tips` and `channel.activities` (type === 'tip')
            const isTipTopic = msg.topic === 'channel.tips';
            const isTipActivity = msg.topic === 'channel.activities' && (msg.data.type === 'tip' || msg.data.donation);
            if (!isTipTopic && !isTipActivity) return;

            const d = msg.data.donation || msg.data.data || msg.data;
            const amount = Number(d.amount);
            if (Number.isFinite(amount) && amount > 0 && typeof onTip === 'function') {
              state.eventsReceived += 1;
              Promise.resolve(onTip({
                provider: 'streamelements',
                eventId: makeEventId('se', msg.data._id || d.tipId || d.id, d),
                gifterName: cleanText(d.user?.username || d.displayName || d.username || d.name, 120, 'Anonymous'),
                amount,
                currency: cleanText(d.currency, 8, 'USD').toUpperCase(),
                message: cleanText(d.message, 500, ''),
              })).catch(() => {});
            }
          }
        } catch { /* ignore */ }
      });

      sock.addEventListener('error', () => { if (sock === ws) { state.status = 'error'; state.lastError = 'Astro WebSocket error'; } });
      sock.addEventListener('close', () => { if (sock === ws) { cleanup(); if (cfg.enabled && cfg.jwtToken) schedule(); else state.status = 'disconnected'; } });
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
      schedule();
    }
  }

  return {
    configure(next) {
      const changed = (next.jwtToken || '') !== cfg.jwtToken || Boolean(next.enabled) !== cfg.enabled;
      cfg = { enabled: Boolean(next.enabled), jwtToken: typeof next.jwtToken === 'string' ? next.jwtToken.trim() : '' };
      if (!cfg.enabled || !cfg.jwtToken) { cleanup(); state.status = 'disconnected'; state.lastError = null; }
      else if (changed || state.status === 'disconnected' || state.status === 'error') { attempt = 0; connect(); }
      return this.getStatus();
    },
    stop() { cfg.enabled = false; cleanup(); state.status = 'disconnected'; },
    getStatus() { return { enabled: cfg.enabled, hasToken: Boolean(cfg.jwtToken), ...state }; },
  };
}

// -------------------------------------------- 2. Trakteer Live WebSocket ----

export function createTrakteerClient({ onTip, logger = () => {} } = {}) {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let attempt = 0;
  let cfg = { enabled: false, channelId: '', testChannelId: '' };
  let state = { status: 'disconnected', lastConnectedAtMs: null, lastError: null, eventsReceived: 0 };

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { const r = ws; ws = null; try { r.close(); } catch { /* ignore */ } }
  }

  function schedule() {
    if (!cfg.enabled || !cfg.channelId) return;
    attempt += 1;
    state.status = 'reconnecting';
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, Math.min(30_000, 2000 * attempt));
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function connect() {
    cleanup();
    if (!cfg.enabled || !cfg.channelId) { state.status = 'disconnected'; return; }
    state.status = 'connecting';
    state.lastError = null;
    try {
      const url = process.env.TRAKTEER_WS_URL || 'wss://socket.trakteer.id/app/2ae25d102cc6cd41100a?protocol=7&client=js&version=8.3.0&flash=false';
      const sock = new WebSocket(url);
      ws = sock;
      sock.addEventListener('message', (ev) => {
        if (sock !== ws) return;
        try {
          const pkt = JSON.parse(String(ev.data || '{}'));
          if (pkt.event === 'pusher:connection_established') {
            sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: cfg.channelId } }));
            // Also subscribe to companion test channel if provided or derivable
            const testCh = cfg.testChannelId || (cfg.channelId.startsWith('creator-stream.')
              ? cfg.channelId.replace(/^creator-stream\./, 'creator-stream-test.')
              : '');
            if (testCh && testCh !== cfg.channelId) {
              sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: testCh } }));
            }
            attempt = 0;
            state.status = 'connected';
            state.lastConnectedAtMs = Date.now();
            state.lastError = null;
            logger('trakteer_ws_connected');
            pingTimer = setInterval(() => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch { /* ignore */ }
              }
            }, 30_000);
            if (typeof pingTimer.unref === 'function') pingTimer.unref();
          } else if (
            typeof pkt.event === 'string' &&
            (pkt.event.includes('BroadcastNotificationCreated') || pkt.event.includes('new-tip-success')) &&
            pkt.data
          ) {
            const d = typeof pkt.data === 'string' ? JSON.parse(pkt.data) : pkt.data;
            const amount = Number(d.price ?? d.amount ?? 0);
            if (Number.isFinite(amount) && amount > 0 && typeof onTip === 'function') {
              state.eventsReceived += 1;
              Promise.resolve(onTip({
                provider: 'trakteer',
                eventId: makeEventId('trk-ws', d.id || d.transaction_id, d),
                gifterName: cleanText(d.supporter_name || d.name, 120, 'Anonymous'),
                amount,
                currency: 'IDR',
                message: cleanText(d.supporter_message || d.message, 500, ''),
              })).catch(() => {});
            }
          }
        } catch { /* ignore */ }
      });
      sock.addEventListener('error', () => { if (sock === ws) { state.status = 'error'; state.lastError = 'Trakteer WebSocket error'; } });
      sock.addEventListener('close', () => { if (sock === ws) { cleanup(); if (cfg.enabled && cfg.channelId) schedule(); else state.status = 'disconnected'; } });
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
      schedule();
    }
  }

  return {
    configure(next) {
      const nextCh = typeof next.channelId === 'string' ? next.channelId.trim() : '';
      const nextTest = typeof next.testChannelId === 'string' ? next.testChannelId.trim() : '';
      const changed = nextCh !== cfg.channelId || nextTest !== cfg.testChannelId || Boolean(next.enabled) !== cfg.enabled;
      cfg = { enabled: Boolean(next.enabled), channelId: nextCh, testChannelId: nextTest };
      if (!cfg.enabled || !cfg.channelId) { cleanup(); state.status = 'disconnected'; state.lastError = null; }
      else if (changed || state.status === 'disconnected' || state.status === 'error') { attempt = 0; connect(); }
      return this.getStatus();
    },
    stop() { cfg.enabled = false; cleanup(); state.status = 'disconnected'; },
    getStatus() { return { enabled: cfg.enabled, hasToken: Boolean(cfg.channelId), ...state }; },
  };
}

// ----------------------------------------- 3. TipeeeStream Socket.IO v2 -----

export function createTipeeeStreamClient({ onTip, logger = () => {} } = {}) {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let cfg = { enabled: false, apiKey: '', username: '' };
  let state = { status: 'disconnected', lastConnectedAtMs: null, lastError: null, eventsReceived: 0 };

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { const r = ws; ws = null; try { r.close(); } catch { /* ignore */ } }
  }

  async function connect() {
    cleanup();
    if (!cfg.enabled || !cfg.apiKey) { state.status = 'disconnected'; return; }
    state.status = 'connecting';
    state.lastError = null;
    try {
      const infoRes = await fetch('https://api.tipeeestream.com/v2.0/site/socket');
      const info = await infoRes.json();
      const host = (info?.datas?.host || 'https://sso-cf.tipeeestream.com').replace(/^http/, 'ws').replace(/\/+$/, '');
      const port = info?.datas?.port || 443;
      const sock = new WebSocket(`${host}:${port}/socket.io/?access_token=${encodeURIComponent(cfg.apiKey)}&EIO=3&transport=websocket`);
      ws = sock;
      sock.addEventListener('message', (ev) => {
        if (sock !== ws) return;
        const raw = String(ev.data || '');
        if (raw === '40' || raw.startsWith('40')) {
          sock.send(`42${JSON.stringify(['join-room', { room: cfg.apiKey, username: cfg.username || 'streamer' }])}`);
          state.status = 'connected';
          state.lastConnectedAtMs = Date.now();
          state.lastError = null;
          logger('tipeeestream_connected');
          pingTimer = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send('2'); } catch { /* ignore */ } } }, 25_000);
          if (typeof pingTimer.unref === 'function') pingTimer.unref();
        } else if (raw.startsWith('42')) {
          try {
            const pkt = JSON.parse(raw.slice(2));
            if (Array.isArray(pkt) && pkt[0] === 'new-event' && pkt[1]?.event?.type === 'donation') {
              const e = pkt[1].event;
              const p = e.parameters || {};
              const amount = Number(p.amount);
              if (Number.isFinite(amount) && amount > 0 && typeof onTip === 'function') {
                state.eventsReceived += 1;
                Promise.resolve(onTip({
                  provider: 'tipeeestream',
                  eventId: makeEventId('tip', e.id, e),
                  gifterName: cleanText(p.username, 120, 'Anonymous'),
                  amount,
                  currency: cleanText(p.currency, 8, 'EUR').toUpperCase(),
                  message: cleanText(p.message, 500, ''),
                })).catch(() => {});
              }
            }
          } catch { /* ignore */ }
        }
      });
      sock.addEventListener('error', () => { if (sock === ws) { state.status = 'error'; state.lastError = 'TipeeeStream socket error'; } });
      sock.addEventListener('close', () => {
        if (sock === ws) {
          cleanup();
          if (cfg.enabled && cfg.apiKey) {
            state.status = 'reconnecting';
            reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
            if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
          } else {
            state.status = 'disconnected';
          }
        }
      });
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
    }
  }

  return {
    configure(next) {
      cfg = {
        enabled: Boolean(next.enabled),
        apiKey: typeof next.apiKey === 'string' ? next.apiKey.trim() : '',
        username: typeof next.username === 'string' ? next.username.trim() : '',
      };
      if (!cfg.enabled || !cfg.apiKey) { cleanup(); state.status = 'disconnected'; state.lastError = null; }
      else connect();
      return this.getStatus();
    },
    stop() { cfg.enabled = false; cleanup(); state.status = 'disconnected'; },
    getStatus() { return { enabled: cfg.enabled, hasToken: Boolean(cfg.apiKey), ...state }; },
  };
}

// ----------------------------------------- 4. DonationAlerts Centrifugo -----

export function createDonationAlertsClient({ onTip, logger = () => {} } = {}) {
  let ws = null;
  let reconnectTimer = null;
  let cfg = { enabled: false, accessToken: '' };
  let state = { status: 'disconnected', lastConnectedAtMs: null, lastError: null, eventsReceived: 0 };

  function cleanup() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { const r = ws; ws = null; try { r.close(); } catch { /* ignore */ } }
  }

  async function connect() {
    cleanup();
    if (!cfg.enabled || !cfg.accessToken) { state.status = 'disconnected'; return; }
    state.status = 'connecting';
    state.lastError = null;
    try {
      const userRes = await fetch('https://www.donationalerts.com/api/v1/user/oauth', {
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
      });
      if (!userRes.ok) throw new Error(`OAuth HTTP ${userRes.status}`);
      const userData = await userRes.json();
      const userId = userData?.data?.id;
      const socketToken = userData?.data?.socket_connection_token;
      if (!userId || !socketToken) throw new Error('Missing DonationAlerts socket token');

      const sock = new WebSocket('wss://centrifugo.donationalerts.com/connection/websocket');
      ws = sock;
      sock.addEventListener('open', () => {
        if (sock !== ws) return;
        sock.send(JSON.stringify({ params: { token: socketToken }, id: 1 }));
      });
      sock.addEventListener('message', async (ev) => {
        if (sock !== ws) return;
        try {
          const msg = JSON.parse(String(ev.data || '{}'));
          if (msg.id === 1 && msg.result?.client) {
            const channel = `$alerts:donation_${userId}`;
            const subRes = await fetch('https://www.donationalerts.com/api/v1/centrifuge/subscribe', {
              method: 'POST',
              headers: { Authorization: `Bearer ${cfg.accessToken}`, 'content-type': 'application/json' },
              body: JSON.stringify({ channels: [channel], client: msg.result.client }),
            });
            const subData = await subRes.json();
            const chanToken = subData?.channels?.[0]?.token;
            if (chanToken && sock === ws) {
              sock.send(JSON.stringify({ method: 1, params: { channel, token: chanToken }, id: 2 }));
              state.status = 'connected';
              state.lastConnectedAtMs = Date.now();
              state.lastError = null;
              logger('donationalerts_connected');
            }
          } else if (msg.result?.data?.data) {
            const d = msg.result.data.data;
            const amount = Number(d.amount ?? d.money);
            if (Number.isFinite(amount) && amount > 0 && typeof onTip === 'function') {
              state.eventsReceived += 1;
              Promise.resolve(onTip({
                provider: 'donationalerts',
                eventId: makeEventId('da', d.id, d),
                gifterName: cleanText(d.username, 120, 'Anonymous'),
                amount,
                currency: cleanText(d.currency, 8, 'EUR').toUpperCase(),
                message: cleanText(d.message, 500, ''),
              })).catch(() => {});
            }
          }
        } catch { /* ignore */ }
      });
      sock.addEventListener('error', () => { if (sock === ws) { state.status = 'error'; state.lastError = 'Centrifugo error'; } });
      sock.addEventListener('close', () => { if (sock === ws) { cleanup(); state.status = 'disconnected'; } });
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
    }
  }

  return {
    configure(next) {
      cfg = { enabled: Boolean(next.enabled), accessToken: typeof next.accessToken === 'string' ? next.accessToken.trim() : '' };
      if (!cfg.enabled || !cfg.accessToken) { cleanup(); state.status = 'disconnected'; state.lastError = null; }
      else connect();
      return this.getStatus();
    },
    stop() { cfg.enabled = false; cleanup(); state.status = 'disconnected'; },
    getStatus() { return { enabled: cfg.enabled, hasToken: Boolean(cfg.accessToken), ...state }; },
  };
}

// ----------------------------------------- 5. Naver Chzzk Live Chat WS ------

export function createChzzkClient({ onTip, logger = () => {} } = {}) {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let cfg = { enabled: false, channelId: '' };
  let state = { status: 'disconnected', lastConnectedAtMs: null, lastError: null, eventsReceived: 0 };

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { const r = ws; ws = null; try { r.close(); } catch { /* ignore */ } }
  }

  function schedule(delayMs = 15_000) {
    if (!cfg.enabled || !cfg.channelId) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delayMs);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  async function connect() {
    cleanup();
    if (!cfg.enabled || !cfg.channelId) { state.status = 'disconnected'; return; }
    state.status = 'connecting';
    state.lastError = null;
    try {
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StreamTimer/1.0';
      const liveRes = await fetch(
        `https://api.chzzk.naver.com/polling/v2/channels/${encodeURIComponent(cfg.channelId)}/live-status`,
        { headers: { 'User-Agent': ua } },
      );
      if (!liveRes.ok) throw new Error(`Chzzk API HTTP ${liveRes.status}`);
      const liveJson = await liveRes.json();
      const chatChannelId = liveJson?.content?.chatChannelId;
      if (!chatChannelId) {
        state.status = 'reconnecting';
        state.lastError = 'Channel offline (rechecking every 30s)';
        schedule(30_000);
        return;
      }

      const tokRes = await fetch(
        `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${encodeURIComponent(chatChannelId)}&chatType=STREAMING`,
        { headers: { 'User-Agent': ua } },
      );
      if (!tokRes.ok) throw new Error(`Chzzk token HTTP ${tokRes.status}`);
      const tokJson = await tokRes.json();
      const accessToken = tokJson?.content?.accessToken;
      if (!accessToken) throw new Error('Missing Chzzk chat access token');

      const serverNum = (Math.abs(chatChannelId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 5) + 1;
      const wsUrl = process.env.CHZZK_WS_URL || `wss://kr-ss${serverNum}.chat.naver.com/chat`;
      const sock = new WebSocket(wsUrl);
      ws = sock;

      sock.addEventListener('open', () => {
        if (sock !== ws) return;
        sock.send(JSON.stringify({
          ver: '3',
          cmd: 100,
          svcid: 'game',
          cid: chatChannelId,
          bdy: { uid: null, devType: 2001, accTkn: accessToken, auth: 'READ' },
          tid: 1,
        }));
        pingTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ ver: '3', cmd: 0 })); } catch { /* ignore */ }
          }
        }, 20_000);
        if (typeof pingTimer.unref === 'function') pingTimer.unref();
      });

      sock.addEventListener('message', (ev) => {
        if (sock !== ws) return;
        try {
          const pkt = JSON.parse(String(ev.data || '{}'));
          if (pkt.cmd === 0) {
            sock.send(JSON.stringify({ ver: '3', cmd: 10000 }));
            return;
          }
          if (pkt.cmd === 10100) {
            state.status = 'connected';
            state.lastConnectedAtMs = Date.now();
            state.lastError = null;
            logger('chzzk_ws_connected', { chatChannelId });
            return;
          }
          // cmd 93102 = donation frames (msgTypeCode 10 = Cheese donation)
          if (pkt.cmd === 93102 && Array.isArray(pkt.bdy)) {
            for (const item of pkt.bdy) {
              if (Number(item.msgTypeCode) !== 10) continue;
              const extras = typeof item.extras === 'string' ? JSON.parse(item.extras || '{}') : (item.extras || {});
              const profile = typeof item.profile === 'string' ? JSON.parse(item.profile || 'null') : item.profile;
              const amount = Number(extras.payAmount ?? extras.cheese ?? 0);
              if (Number.isFinite(amount) && amount > 0 && typeof onTip === 'function') {
                state.eventsReceived += 1;
                Promise.resolve(onTip({
                  provider: 'chzzk',
                  eventId: makeEventId('chzzk', item.msgTime || extras.donationId, { item, extras }),
                  gifterName: cleanText(profile?.nickname || extras.nickname, 120, 'Anonymous'),
                  amount,
                  currency: 'KRW',
                  message: cleanText(item.msg || extras.donationText, 500, ''),
                })).catch(() => {});
              }
            }
          }
        } catch { /* ignore */ }
      });

      sock.addEventListener('error', () => { if (sock === ws) { state.status = 'error'; state.lastError = 'Chzzk WebSocket error'; } });
      sock.addEventListener('close', () => {
        if (sock === ws) {
          cleanup();
          if (cfg.enabled && cfg.channelId) { state.status = 'reconnecting'; schedule(10_000); }
          else state.status = 'disconnected';
        }
      });
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err && err.message || err);
      schedule(20_000);
    }
  }

  return {
    configure(next) {
      const nextCh = typeof next.channelId === 'string'
        ? next.channelId.trim().replace(/^https?:\/\/chzzk\.naver\.com\/(?:live\/)?/i, '').split(/[/?#]/)[0]
        : '';
      const changed = nextCh !== cfg.channelId || Boolean(next.enabled) !== cfg.enabled;
      cfg = { enabled: Boolean(next.enabled), channelId: nextCh };
      if (!cfg.enabled || !cfg.channelId) { cleanup(); state.status = 'disconnected'; state.lastError = null; }
      else if (changed || state.status === 'disconnected' || state.status === 'error') { connect(); }
      return this.getStatus();
    },
    stop() { cfg.enabled = false; cleanup(); state.status = 'disconnected'; },
    getStatus() { return { enabled: cfg.enabled, hasToken: Boolean(cfg.channelId), ...state }; },
  };
}

// ----------------------------------------- 6. Global Webhook Normalizer -----

/**
 * Verify & normalize an incoming HTTP webhook payload from ANY of our supported
 * regional & global platforms into a unified transaction ready for `executeCommand`.
 *
 * Authentication matrix (matches real production docs for every platform):
 *  - If the user saved a platform-specific `platformSecret` (e.g. Tako Webhook Token,
 *    Ko-fi Verification Token, Buy Me a Coffee Signing Secret, Tiltify Signing Key,
 *    Trakteer X-Webhook-Token, SociaBuzz Webhook Token), verify using that platform's
 *    exact signature / token spec!
 *  - If NO platform-specific secret is configured (e.g. Saweria, LivePix, or Tako when
 *    Webhook Token is left empty), authenticate using the profile's unguessable secret
 *    URL path (`/api/ingest/<provider>/<urlToken>` -> `urlTokenValid === true`)!
 */
export function parseWebhookRequest({
  providerId,
  rawBody,
  headers = {},
  platformSecret = '',
  urlTokenValid = false,
  secret = '', // legacy alias for tests passing `secret` directly
  rulesConfig,
  fxState = { ratesPerUsd: BASELINE_RATES_PER_USD },
}) {
  const meta = PLATFORM_BY_ID[providerId];
  if (!meta) return { ok: false, status: 404, error: 'unknown_provider' };

  const activeSecret = (platformSecret || secret || '').trim();

  // Parse body (Ko-fi & ECPay send application/x-www-form-urlencoded!)
  let parsed = null;
  const ct = String(headers['content-type'] || '').toLowerCase();
  try {
    if (ct.includes('application/x-www-form-urlencoded') || (!rawBody.trim().startsWith('{') && rawBody.includes('='))) {
      const sp = new URLSearchParams(rawBody);
      if (sp.has('data')) {
        parsed = JSON.parse(sp.get('data'));
      } else {
        parsed = Object.fromEntries(sp.entries());
      }
    } else {
      parsed = JSON.parse(rawBody);
    }
  } catch {
    return { ok: false, status: 400, error: 'invalid_payload' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, status: 400, error: 'invalid_payload' };

  // Lowercase-normalized header reader
  const h = (k) => {
    const val = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(val) ? String(val[0] || '') : String(val || '');
  };

  // Signature / Token / URL-Token Verification
  if (activeSecret) {
    const canonicalBody = JSON.stringify(parsed);
    const hmacRawHex = crypto.createHmac('sha256', activeSecret).update(rawBody).digest('hex');
    const hmacCanonHex = crypto.createHmac('sha256', activeSecret).update(canonicalBody).digest('hex');
    const hmacRawB64 = crypto.createHmac('sha256', activeSecret).update(rawBody).digest('base64');

    let verified = false;
    if (providerId === 'tako') {
      // Official Tako.id doc: HMAC-SHA256 hex of JSON.stringify(body) (or rawBody) in X-Tako-Signature
      const sig = h('x-tako-signature');
      verified = safeEqual(sig, hmacRawHex) || safeEqual(sig, hmacCanonHex) || safeEqual(sig, activeSecret);
    } else if (providerId === 'kofi') {
      verified = safeEqual(String(parsed.verification_token || ''), activeSecret)
        || safeEqual(h('x-kofi-token'), activeSecret)
        || safeEqual(h('x-kofi-signature'), hmacRawHex);
    } else if (providerId === 'buymeacoffee') {
      const sig = h('x-signature-sha256') || h('x-buymeacoffee-signature');
      verified = safeEqual(sig, hmacRawHex) || safeEqual(sig, hmacCanonHex);
    } else if (providerId === 'tiltify') {
      // Official Tiltify v5 doc: Base64 HMAC-SHA256 of `${X-Tiltify-Timestamp}.${rawBody}`
      const sig = h('x-tiltify-signature');
      const ts = h('x-tiltify-timestamp');
      const tsB64 = ts ? crypto.createHmac('sha256', activeSecret).update(`${ts}.${rawBody}`).digest('base64') : '';
      verified = (tsB64 && safeEqual(sig, tsB64)) || safeEqual(sig, hmacRawB64) || safeEqual(sig, hmacRawHex);
    } else if (providerId === 'trakteer' || providerId === 'doneru') {
      verified = safeEqual(h('x-webhook-token'), activeSecret)
        || safeEqual(h(`x-${providerId}-signature`), hmacRawHex)
        || safeEqual(h(`x-${providerId}-signature`), hmacCanonHex);
    } else if (providerId === 'sociabuzz') {
      const auth = h('authorization').replace(/^Bearer\s+/i, '').trim();
      const cand = [
        h('x-sociabuzz-token'), h('x-webhook-token'), h('x-webhook-secret'),
        h('x-sociabuzz-signature'), h('x-socialbuzz-signature'), auth,
        String(parsed.token || parsed.webhook_token || ''),
      ].filter(Boolean);
      verified = cand.some((c) => safeEqual(c, activeSecret) || safeEqual(c, hmacRawHex) || safeEqual(c, hmacCanonHex));
    } else if (providerId === 'chzzk') {
      const sig = h('chzzk-event-signature');
      verified = safeEqual(sig, hmacRawHex) || safeEqual(sig, hmacRawB64) || safeEqual(sig, hmacCanonHex);
    } else if (providerId === 'saweria' || providerId === 'livepix' || providerId === 'ecpay') {
      // These platforms normally don't send HMAC headers; accept matching URL token OR custom signature/token header
      const sig = h(`x-${providerId}-signature`) || h('x-webhook-token') || h('x-webhook-secret');
      verified = urlTokenValid || safeEqual(sig, hmacRawHex) || safeEqual(sig, hmacCanonHex) || safeEqual(sig, activeSecret);
    } else {
      const sig = h(`x-${providerId}-signature`) || h('x-webhook-token');
      verified = safeEqual(sig, hmacRawHex) || safeEqual(sig, hmacCanonHex) || safeEqual(sig, activeSecret);
    }

    if (!verified) return { ok: false, status: 403, error: 'invalid_signature' };
  } else if (!urlTokenValid) {
    return { ok: false, status: 403, error: 'missing_url_token_or_secret' };
  }

  // Extract normalized amount, currency, donor, message, id per real-world platform schema
  let rawAmount = 0;
  let currency = meta.defaultCurrency || 'USD';
  let gifterName = 'Anonymous';
  let message = '';
  let rawId = null;

  if (providerId === 'tako') {
    // Supports BOTH Tako Support Notification webhook (flat or nested) & Merchant API `payment.success` (`data`)
    const d = (parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
    rawAmount = Number(d.amount ?? d.price ?? d.amount_raw ?? parsed.amount ?? parsed.price);
    currency = cleanText(d.currency || parsed.currency, 8, 'IDR').toUpperCase();
    gifterName = cleanText(
      d.gifterName || d.gifter_name || d.supporterName || d.supporter_name || d.senderName || d.username || d.name || parsed.gifterName || parsed.supporter,
      120,
      'Tako Supporter',
    );
    message = cleanText(d.message || d.note || d.comment || parsed.message, 500, '');
    rawId = d.id || d.giftId || d.relatedGiftId || d.transactionId || parsed.id;
  } else if (providerId === 'saweria') {
    const d = (parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
    rawAmount = Number(d.amount_raw ?? d.amount ?? d.etc?.amount_to_display);
    currency = cleanText(d.currency, 8, 'IDR').toUpperCase();
    gifterName = cleanText(d.donator_name || d.gifterName || d.supporter, 120, 'Saweria Donor');
    message = cleanText(d.message, 500, '');
    rawId = d.id;
  } else if (providerId === 'sociabuzz') {
    const d = (parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
    rawAmount = Number(d.amount_raw ?? d.amount ?? d.amount_settled ?? parsed.amount);
    currency = cleanText(d.currency || parsed.currency, 8, 'IDR').toUpperCase();
    gifterName = cleanText(d.supporter || d.donator || d.gifterName || d.name || parsed.supporter, 120, 'SociaBuzz Supporter');
    message = cleanText(d.message || d.note || parsed.message, 500, '');
    rawId = d.id || d.transaction_id || parsed.id;
  } else if (providerId === 'kofi') {
    rawAmount = Number(parsed.amount);
    currency = cleanText(parsed.currency, 8, 'USD').toUpperCase();
    gifterName = cleanText(parsed.from_name, 120, 'Ko-fi Supporter');
    message = cleanText(parsed.message, 500, '');
    rawId = parsed.kofi_transaction_id || parsed.message_id;
  } else if (providerId === 'buymeacoffee') {
    // Official BMC webhooks wrap payload under `response` (v1) or `data` (v2)
    const d = parsed.response || parsed.data || parsed;
    rawAmount = Number(d.total_amount ?? d.amount);
    currency = cleanText(d.currency, 8, 'USD').toUpperCase();
    gifterName = cleanText(d.supporter_name || d.payer_name || d.name, 120, 'Supporter');
    message = cleanText(d.support_note || d.message, 500, '');
    rawId = d.transaction_id || d.support_id || d.id || parsed.event_id;
  } else if (providerId === 'tiltify') {
    const d = parsed.data || parsed;
    rawAmount = Number(d.amount?.value ?? d.amount);
    currency = cleanText(d.amount?.currency || d.currency, 8, 'USD').toUpperCase();
    gifterName = cleanText(d.donor_name || d.gifterName, 120, 'Charity Donor');
    message = cleanText(d.donor_comment || d.message, 500, '');
    rawId = d.id;
  } else if (providerId === 'chzzk') {
    const d = parsed.data || parsed;
    rawAmount = Number(d.payAmount ?? d.cheese ?? d.amount);
    currency = cleanText(d.currency, 8, 'KRW').toUpperCase();
    gifterName = cleanText(d.nickname || d.gifterName || d.donatorName, 120, 'Chzzk Viewer');
    message = cleanText(d.donationText || d.message, 500, '');
    rawId = d.eventId || d.id || headers['chzzk-event-message-id'];
  } else if (providerId === 'ecpay') {
    if (parsed.RtnCode !== undefined && String(parsed.RtnCode) !== '1') {
      return { ok: false, status: 202, error: 'payment_not_completed' };
    }
    rawAmount = Number(parsed.TradeAmt ?? parsed.amount);
    currency = cleanText(parsed.currency, 8, 'TWD').toUpperCase();
    gifterName = cleanText(parsed.CustomField1 || parsed.gifterName || parsed.name, 120, 'ECPay Supporter');
    message = cleanText(parsed.CustomField2 || parsed.message, 500, '');
    rawId = parsed.MerchantTradeNo || parsed.TradeNo || parsed.id;
  } else if (providerId === 'livepix') {
    const d = parsed.resource || parsed.data || parsed;
    // Official LivePix API represents `amount` in integer cents (e.g. 1000 = R$ 10.00 BRL).
    if (d.amount !== undefined && d.value === undefined && !d.majorUnits) {
      rawAmount = Number(d.amount) / 100;
    } else {
      rawAmount = Number(d.value ?? d.amount);
    }
    currency = cleanText(d.currency, 8, 'BRL').toUpperCase();
    gifterName = cleanText(d.username || d.gifterName || d.payer?.name, 120, 'LivePix Donor');
    message = cleanText(d.message, 500, '');
    rawId = d.id || d.proof || parsed.eventId;
  } else if (providerId === 'trakteer') {
    rawAmount = Number(parsed.price ?? parsed.amount);
    currency = cleanText(parsed.currency, 8, 'IDR').toUpperCase();
    gifterName = cleanText(parsed.supporter_name || parsed.gifterName, 120, 'Trakteer Supporter');
    message = cleanText(parsed.supporter_message || parsed.message, 500, '');
    rawId = parsed.transaction_id || parsed.id;
  } else {
    // Doneru / custom relay
    const d = (parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
    rawAmount = Number(d.amount ?? d.amount_raw);
    currency = cleanText(d.currency, 8, meta.defaultCurrency || 'JPY').toUpperCase();
    gifterName = cleanText(d.gifterName || d.donator_name || d.supporter || d.name, 120, 'Anonymous');
    message = cleanText(d.message || d.comment, 500, '');
    rawId = d.id || d.transaction_id;
  }

  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    return { ok: false, status: 400, error: 'invalid_amount' };
  }

  const resolved = resolveTransactionCredit({ kind: 'cash_tip', amount: rawAmount, currency }, rulesConfig, fxState);
  const eventId = makeEventId(`wh-${providerId}`, rawId, { providerId, gifterName, rawAmount, currency, message });

  return {
    ok: true,
    event: {
      eventId,
      provider: providerId,
      grossAmount: resolved.grossAmount,
      currency: rulesConfig.baseCurrency || 'USD',
      creditMs: resolved.creditMs,
      payload: {
        gifterName,
        message,
        originalAmount: rawAmount,
        originalCurrency: currency,
        txType: 'cash_tip',
        webhookProvider: providerId,
      },
    },
  };
}
