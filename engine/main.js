// Stream Timer Desktop — 100% Local Native Engine (HTTP + SSE + SQLite WAL + Live Sockets).
//
// Binds strictly to 127.0.0.1. Serves the Apple UI to Tauri WebView2 (or local
// browser), serves OBS Browser Source at /source, manages isolated per-profile
// SQLite WAL databases, live WebSocket connections, webhooks, FX sync, and
// 5-format financial exports.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createProfileStore } from './profiles.js';
import {
  executeCommand, readSnapshot, readDonationRules, updateDonationRules,
  readDonationHistory, resetAddedCounter, deleteDonations,
  readOverlayConfig, updateOverlayConfig,
  readIntegrationConfig, readAllIntegrationConfigs, updateIntegrationConfig,
  readFinanceConfig, updateFinanceConfig, readFinanceSessions,
  startNewFinanceSession, updateFinanceSessionMeta,
  recalculateFinanceSnapshots, readFinanceReport,
} from './mutation.js';
import { validateCommand, resolveTransactionCredit, buildDefaultRulesForCurrency } from './domain.js';
import {
  exportFinanceCsv, exportFinanceJson, exportFinanceMarkdown,
  exportFinanceHtmlReport, exportFinanceXlsx, buildDefaultFinanceConfig,
} from './finance.js';
import { createFxScheduler } from './fx.js';
import { DONATION_PLATFORMS, PLATFORM_BY_ID, REGION_GROUPS } from './platforms.js';
import {
  createStreamlabsClient, normalizeStreamlabsEvent, buildSyntheticStreamlabsEvent,
  DEFAULT_STREAMLABS_FILTERS, sanitizeStreamlabsFilters, verifyStreamlabsToken,
} from './sockets/streamlabs.js';
import {
  createStreamElementsClient, createTrakteerClient,
  createTipeeeStreamClient, createDonationAlertsClient, createChzzkClient, parseWebhookRequest,
} from './sockets/global-sockets.js';
import { createTunnelManager } from './tunnel.js';
import { createUpdateManager, APP_VERSION } from './updater.js';
import { addClient, removeClient, broadcast, broadcastEvent, clientStats } from './sse.js';
import { nowMs } from './clock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, '..', 'ui');

const HOST = '127.0.0.1';
const REQUESTED_PORT = process.env.STREAM_TIMER_PORT !== undefined
  ? Number(process.env.STREAM_TIMER_PORT)
  : (process.env.PORT !== undefined ? Number(process.env.PORT) : 47120);
const MAX_BODY = 2 * 1024 * 1024; // 2 MB (allows importing .stbackup files)
const OP_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

let boundPort = REQUESTED_PORT;

function log(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        const err = new Error('request body too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStaticFile(res, absPath) {
  const normalized = path.normalize(absPath);
  if (!normalized.startsWith(UI_DIR) || !fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
    return sendJson(res, 404, { error: 'not_found' });
  }
  const ext = path.extname(normalized).toLowerCase();
  const body = fs.readFileSync(normalized);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  res.end(body);
}

// -------------------------------------------- Profile Store & Live Hubs -----

const store = createProfileStore();

function activeCtx() {
  const profile = store.getActiveProfile();
  if (!profile) return null;
  const db = store.openProfileDb(profile.id);
  const fx = store.getFxState();
  return { profile, db, fx };
}

function broadcastOverlayTotals() {
  const ctx = activeCtx();
  if (!ctx) return null;
  const cfg = readOverlayConfig(ctx.db);
  const hist = readDonationHistory(ctx.db, { limit: 1 });
  const payload = { ...cfg, totalCreditMs: hist.stats.totalCreditMs, baseCurrency: ctx.profile.baseCurrency };
  broadcastEvent('overlay', payload);
  return payload;
}

function applyNormalizedDonation({ eventId, provider, grossAmount, creditMs, payload }) {
  const ctx = activeCtx();
  if (!ctx) return { status: 409, body: { error: 'no_active_profile' } };
  const command = { type: 'add', amountMs: creditMs };
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({ provider, grossAmount, creditMs, currency: ctx.profile.baseCurrency }))
    .digest('hex');
  const result = executeCommand(ctx.db, command, eventId, hash, {
    provider,
    grossAmount,
    currency: ctx.profile.baseCurrency,
    creditMs,
    payload,
  }, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);

  if (result.status === 200) {
    if (result.changed) broadcast(result.body);
    broadcastOverlayTotals();
    broadcastEvent('activity', { eventId, provider, grossAmount, creditMs, gifterName: payload?.gifterName || 'Anonymous' });
  }
  return result;
}

function applyTipFromSocket({ provider, eventId, gifterName, amount, currency, message }) {
  const ctx = activeCtx();
  if (!ctx) return;
  const rules = readDonationRules(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);
  const res = resolveTransactionCredit({ kind: 'cash_tip', amount, currency }, rules, ctx.fx);
  applyNormalizedDonation({
    eventId,
    provider,
    grossAmount: res.grossAmount,
    creditMs: res.creditMs,
    payload: {
      gifterName,
      message,
      originalAmount: amount,
      originalCurrency: currency,
      txType: 'cash_tip',
    },
  });
}

function applyStreamlabsEnvelope(eventData, filters) {
  const ctx = activeCtx();
  if (!ctx) return [];
  const rules = readDonationRules(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);
  const items = normalizeStreamlabsEvent(eventData, rules, ctx.fx, filters);
  const applied = [];
  for (const item of items) {
    const result = applyNormalizedDonation(item);
    applied.push({
      eventId: item.eventId,
      provider: item.provider,
      grossAmount: item.grossAmount,
      creditMs: item.creditMs,
      status: result.status,
      replay: result.replay === true,
      snapshot: result.body,
    });
  }
  return applied;
}

const streamlabsClient = createStreamlabsClient({
  onEvent: (eventData, filters) => applyStreamlabsEnvelope(eventData, filters),
  logger: log,
});
const streamelementsClient = createStreamElementsClient({ onTip: applyTipFromSocket, logger: log });
const trakteerClient = createTrakteerClient({ onTip: applyTipFromSocket, logger: log });
const tipeeestreamClient = createTipeeeStreamClient({ onTip: applyTipFromSocket, logger: log });
const donationalertsClient = createDonationAlertsClient({ onTip: applyTipFromSocket, logger: log });
const chzzkClient = createChzzkClient({ onTip: applyTipFromSocket, logger: log });

const lastWebhookByProvider = Object.create(null);

const tunnelManager = createTunnelManager({
  dataDir: store.dataDir,
  getLocalPort: () => boundPort,
  logger: log,
});
const savedCustomTunnel = store.getAppMeta().customTunnelUrl;
if (savedCustomTunnel) tunnelManager.setCustomUrl(savedCustomTunnel);

const fxScheduler = createFxScheduler({
  readFxState: () => store.getFxState(),
  saveFxState: (res) => store.updateFxState(res),
  logger: log,
});

const updateManager = createUpdateManager({
  dataDir: store.dataDir,
  getUpdateConfig: () => {
    const m = store.getAppMeta();
    return { autoCheck: m.autoCheckUpdates !== false, autoInstall: Boolean(m.autoInstallUpdates) };
  },
  exportAllProfilesBackup: () => store.getAppMeta().profiles.map((p) => store.exportProfileBackup(p.id)).filter(Boolean),
  logger: log,
});

function stopAllSockets() {
  streamlabsClient.stop();
  streamelementsClient.stop();
  trakteerClient.stop();
  tipeeestreamClient.stop();
  donationalertsClient.stop();
  chzzkClient.stop();
}

function syncSocketsForActiveProfile() {
  stopAllSockets();
  const ctx = activeCtx();
  if (!ctx) return;
  const all = readAllIntegrationConfigs(ctx.db);

  if (all.streamlabs) {
    streamlabsClient.configure({
      enabled: Boolean(all.streamlabs.enabled && all.streamlabs.socketToken),
      socketToken: all.streamlabs.socketToken || '',
      filters: sanitizeStreamlabsFilters(all.streamlabs.filters, DEFAULT_STREAMLABS_FILTERS),
    });
  }
  if (all.streamelements) {
    streamelementsClient.configure({
      enabled: Boolean(all.streamelements.enabled && all.streamelements.jwtToken),
      jwtToken: all.streamelements.jwtToken || '',
    });
  }
  if (all.trakteer) {
    trakteerClient.configure({
      enabled: Boolean(all.trakteer.enabled && all.trakteer.channelId),
      channelId: all.trakteer.channelId || '',
      testChannelId: all.trakteer.testChannelId || '',
    });
  }
  if (all.tipeeestream) {
    tipeeestreamClient.configure({
      enabled: Boolean(all.tipeeestream.enabled && all.tipeeestream.apiKey),
      apiKey: all.tipeeestream.apiKey || '',
      username: all.tipeeestream.username || '',
    });
  }
  if (all.donationalerts) {
    donationalertsClient.configure({
      enabled: Boolean(all.donationalerts.enabled && all.donationalerts.accessToken),
      accessToken: all.donationalerts.accessToken || '',
    });
  }
  if (all.chzzk) {
    chzzkClient.configure({
      enabled: Boolean(all.chzzk.enabled && all.chzzk.channelId),
      channelId: all.chzzk.channelId || '',
    });
  }
}

function allSocketStatuses() {
  return {
    streamlabs: streamlabsClient.getStatus(),
    streamelements: streamelementsClient.getStatus(),
    trakteer: trakteerClient.getStatus(),
    tipeeestream: tipeeestreamClient.getStatus(),
    donationalerts: donationalertsClient.getStatus(),
    chzzk: chzzkClient.getStatus(),
  };
}

// ------------------------------------------------ Filter & Route Helpers ----

function parseFinanceFilters(url) {
  const sp = url.searchParams;
  const numOrNull = (k) => {
    const raw = sp.get(k);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    session: sp.get('session') || 'current',
    q: sp.get('q') || '',
    channel: sp.get('channel') || 'all',
    currency: sp.get('currency') || 'all',
    fromMs: numOrNull('fromMs'),
    toMs: numOrNull('toMs'),
    minGross: numOrNull('minGross'),
    sort: sp.get('sort') || 'latest',
    includeDeleted: sp.get('includeDeleted') === 'true' || sp.get('includeDeleted') === '1',
    limit: numOrNull('limit') || 500,
  };
}

function resolveObsProfile(url) {
  const profileId = url.searchParams.get('profile');
  const token = url.searchParams.get('token');
  const target = profileId ? store.getProfileById(profileId) : store.getActiveProfile();
  if (!target) return null;
  if (token && target.readToken === token) return target;
  // Also allow local unauthenticated preview only if explicitly active on localhost
  if (!token) return target;
  return null;
}

// ------------------------------------------------------------ HTTP Server ---

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${boundPort}`);
    const p = url.pathname;

    // 1. Static UI & OBS Source
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveStaticFile(res, path.join(UI_DIR, 'index.html'));
    }
    if (req.method === 'GET' && p === '/source') {
      const target = resolveObsProfile(url);
      if (!target && url.searchParams.get('token')) {
        return sendJson(res, 401, { error: 'invalid_obs_token' });
      }
      return serveStaticFile(res, path.join(UI_DIR, 'source.html'));
    }
    if (req.method === 'GET' && (p.startsWith('/styles/') || p.startsWith('/js/') || p.startsWith('/i18n/') || p === '/source.css')) {
      return serveStaticFile(res, path.join(UI_DIR, p.slice(1)));
    }

    // 2. Health & App Bootstrap
    if (req.method === 'GET' && p === '/health') {
      return sendJson(res, 200, { ok: true, port: boundPort, clients: clientStats(), nowMs: nowMs() });
    }
    if (req.method === 'GET' && p === '/api/app/bootstrap') {
      const meta = store.getAppMeta();
      return sendJson(res, 200, {
        ...meta,
        port: boundPort,
        fx: store.getFxState(),
        platforms: DONATION_PLATFORMS,
        regions: REGION_GROUPS,
        sockets: allSocketStatuses(),
        tunnel: tunnelManager.getStatus(),
        appVersion: APP_VERSION,
        updates: updateManager.getStatus(),
        draftWebhookToken: crypto.randomBytes(20).toString('hex'),
      });
    }
    if (req.method === 'PUT' && p === '/api/app/settings') {
      const body = JSON.parse(await readBody(req) || '{}');
      const saved = store.updateAppSettings(body);
      return sendJson(res, 200, { ok: true, ...saved });
    }
    if (req.method === 'GET' && p === '/api/currency-presets') {
      const cur = (url.searchParams.get('currency') || 'USD').toUpperCase();
      const fx = store.getFxState();
      return sendJson(res, 200, {
        rules: buildDefaultRulesForCurrency(cur, fx.ratesPerUsd),
        finance: buildDefaultFinanceConfig(cur, fx.ratesPerUsd),
      });
    }

    // 3. Profiles CRUD, Switch & Backup/Restore (.stbackup)
    if (req.method === 'POST' && p === '/api/profiles') {
      const body = JSON.parse(await readBody(req) || '{}');
      const created = store.createProfile(body);
      syncSocketsForActiveProfile();
      const ctx = activeCtx();
      if (ctx) {
        broadcast(readSnapshot(ctx.db));
        broadcastOverlayTotals();
        broadcastEvent('profile_changed', { profile: created });
      }
      return sendJson(res, 200, { ok: true, profile: created, app: store.getAppMeta() });
    }
    if (req.method === 'POST' && p === '/api/profiles/switch') {
      const body = JSON.parse(await readBody(req) || '{}');
      const switched = store.switchProfile(body.profileId);
      if (!switched) return sendJson(res, 404, { error: 'profile_not_found' });
      syncSocketsForActiveProfile();
      const ctx = activeCtx();
      if (ctx) {
        broadcast(readSnapshot(ctx.db));
        broadcastOverlayTotals();
        broadcastEvent('profile_changed', { profile: switched });
      }
      return sendJson(res, 200, { ok: true, profile: switched, app: store.getAppMeta() });
    }
    if (req.method === 'PATCH' && p.startsWith('/api/profiles/')) {
      const id = decodeURIComponent(p.slice('/api/profiles/'.length));
      const body = JSON.parse(await readBody(req) || '{}');
      const updated = store.updateProfile(id, body);
      if (!updated) return sendJson(res, 404, { error: 'profile_not_found' });
      broadcastOverlayTotals();
      return sendJson(res, 200, { ok: true, profile: updated, app: store.getAppMeta() });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/profiles/')) {
      const id = decodeURIComponent(p.slice('/api/profiles/'.length));
      const result = store.deleteProfile(id);
      if (!result.ok) return sendJson(res, 404, result);
      syncSocketsForActiveProfile();
      const ctx = activeCtx();
      if (ctx) {
        broadcast(readSnapshot(ctx.db));
        broadcastOverlayTotals();
      }
      return sendJson(res, 200, { ...result, app: store.getAppMeta() });
    }
    if (req.method === 'GET' && p.startsWith('/api/profiles/') && p.endsWith('/backup')) {
      const id = decodeURIComponent(p.slice('/api/profiles/'.length, -'/backup'.length));
      const bundle = store.exportProfileBackup(id);
      if (!bundle) return sendJson(res, 404, { error: 'profile_not_found' });
      const slug = bundle.profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'profile';
      const body = JSON.stringify(bundle, null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="stream-timer-${slug}.stbackup"`,
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      return res.end(body);
    }
    if (req.method === 'POST' && p === '/api/profiles/import') {
      const body = JSON.parse(await readBody(req) || '{}');
      const imported = store.importProfileBackup(body);
      if (!imported.ok) return sendJson(res, 400, imported);
      syncSocketsForActiveProfile();
      const ctx = activeCtx();
      if (ctx) {
        broadcast(readSnapshot(ctx.db));
        broadcastOverlayTotals();
      }
      return sendJson(res, 200, { ok: true, profile: imported.profile, app: store.getAppMeta() });
    }

    // 4. Streamlabs Token Live Verifier (used in Onboarding Step 3 before profile exists!)
    if (req.method === 'POST' && p === '/api/integrations/streamlabs/verify') {
      const body = JSON.parse(await readBody(req) || '{}');
      const check = await verifyStreamlabsToken(body.socketToken);
      return sendJson(res, 200, check);
    }

    // 5. FX Global Endpoints (work even during onboarding)
    if (req.method === 'GET' && p === '/api/fx') {
      return sendJson(res, 200, store.getFxState());
    }
    if (req.method === 'POST' && p === '/api/fx/refresh') {
      const result = await fxScheduler.refreshNow({ force: true });
      if (!result.ok) return sendJson(res, 502, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, fx: store.getFxState(), provider: result.provider, currencyCount: result.currencyCount });
    }
    if (req.method === 'PUT' && p === '/api/fx') {
      const body = JSON.parse(await readBody(req) || '{}');
      const next = store.updateFxState({
        autoUpdate: typeof body.autoUpdate === 'boolean' ? body.autoUpdate : undefined,
        intervalHours: body.intervalHours,
      });
      if (process.env.FX_AUTO_FETCH !== '0' && next.autoUpdate) {
        fxScheduler.refreshNow({ force: false }).catch(() => {});
      }
      return sendJson(res, 200, { ok: true, fx: next });
    }

    // 6. Tunnel Endpoints (available even during Onboarding Step 6!)
    if (req.method === 'GET' && p === '/api/tunnel') {
      return sendJson(res, 200, tunnelManager.getStatus());
    }
    if (req.method === 'POST' && p === '/api/tunnel/start') {
      return sendJson(res, 200, await tunnelManager.startCloudflared());
    }
    if (req.method === 'POST' && p === '/api/tunnel/custom') {
      const body = JSON.parse(await readBody(req) || '{}');
      const status = tunnelManager.setCustomUrl(body.url || '');
      if (status.mode === 'custom' || status.mode === 'off') {
        store.updateAppSettings({ customTunnelUrl: status.customUrl || '' });
      }
      return sendJson(res, 200, status);
    }
    if (req.method === 'POST' && p === '/api/tunnel/stop') {
      store.updateAppSettings({ customTunnelUrl: '' });
      return sendJson(res, 200, tunnelManager.stop());
    }

    // 6b. Built-In Software Update Endpoints (Semver + SHA-256 + Stream-Safe Guard)
    if (req.method === 'GET' && p === '/api/updates/status') {
      const ctxNow = activeCtx();
      const snapNow = ctxNow ? readSnapshot(ctxNow.db) : null;
      return sendJson(res, 200, {
        ...updateManager.getStatus(),
        isStreamingBusy: Boolean((snapNow && snapNow.state === 'running') || clientStats().obs > 0),
      });
    }
    if (req.method === 'PUT' && p === '/api/updates/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      store.updateAppSettings({
        autoCheckUpdates: typeof body.autoCheck === 'boolean' ? body.autoCheck : undefined,
        autoInstallUpdates: typeof body.autoInstall === 'boolean' ? body.autoInstall : undefined,
      });
      return sendJson(res, 200, { ok: true, updates: updateManager.getStatus() });
    }
    if (req.method === 'POST' && p === '/api/updates/check') {
      const body = JSON.parse(await readBody(req) || '{}');
      const st = await updateManager.checkNow(typeof body.feedUrl === 'string' ? body.feedUrl : '');
      return sendJson(res, 200, { ok: st.status !== 'error', updates: st });
    }
    if (req.method === 'POST' && p === '/api/updates/download') {
      const resDl = await updateManager.downloadAndStage();
      return sendJson(res, resDl.ok ? 200 : 400, resDl);
    }

    // 7. SSE Stream (Panel & OBS)
    if (req.method === 'GET' && p === '/api/stream') {
      const role = url.searchParams.get('role') === 'obs' ? 'obs' : 'panel';
      const ctx = activeCtx();
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write('retry: 1500\n\n');
      addClient(res, { role, profileId: ctx?.profile?.id || null });
      if (ctx) {
        const snap = readSnapshot(ctx.db);
        const ov = readOverlayConfig(ctx.db);
        const hist = readDonationHistory(ctx.db, { limit: 1 });
        res.write(`event: state\ndata: ${JSON.stringify(snap)}\n\n`);
        res.write(`event: overlay\ndata: ${JSON.stringify({ ...ov, totalCreditMs: hist.stats.totalCreditMs, baseCurrency: ctx.profile.baseCurrency })}\n\n`);
      }
      req.on('close', () => removeClient(res));
      return;
    }

    // ── Profile-Scoped Routes Below ──────────────────────────────────────────
    const ctx = activeCtx();
    if (!ctx) {
      return sendJson(res, 409, { error: 'onboarding_required', message: 'Complete profile setup first' });
    }

    // 8. Home Mission Control Glance
    if (req.method === 'GET' && p === '/api/home') {
      const snap = readSnapshot(ctx.db);
      const ov = readOverlayConfig(ctx.db);
      const hist = readDonationHistory(ctx.db, { limit: 5 });
      const finCur = readFinanceReport(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd, { session: 'current', limit: 5 });
      const prevArchived = finCur.sessions.find((s) => !s.isActive) || null;
      return sendJson(res, 200, {
        profile: ctx.profile,
        snapshot: snap,
        overlay: ov,
        clients: clientStats(),
        sockets: allSocketStatuses(),
        tunnel: tunnelManager.getStatus(),
        fx: {
          provider: ctx.fx.provider,
          autoUpdate: ctx.fx.autoUpdate,
          lastUpdatedAtMs: ctx.fx.lastUpdatedAtMs,
          currencyCount: Object.keys(ctx.fx.ratesPerUsd || {}).length,
        },
        recentDonations: hist.donations,
        stats: hist.stats,
        activeIncome: finCur.summary,
        activeSession: finCur.activeSession,
        lastArchivedSession: prevArchived,
      });
    }

    // 9. Timer State & Commands
    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, readSnapshot(ctx.db));
    }
    if (req.method === 'POST' && p === '/api/command/toggle') {
      const snap = readSnapshot(ctx.db);
      const nextCmd = snap.state === 'running' ? { type: 'pause' } : { type: 'resume' };
      const opId = `tog-${crypto.randomUUID()}`;
      const hash = crypto.createHash('sha256').update(JSON.stringify(nextCmd)).digest('hex');
      const result = executeCommand(ctx.db, nextCmd, opId, hash, null, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);
      if (result.status === 200 && result.changed) broadcast(result.body);
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && p === '/api/command') {
      const opId = typeof req.headers['x-operation-id'] === 'string' && OP_ID_RE.test(req.headers['x-operation-id'])
        ? req.headers['x-operation-id']
        : `cmd-${crypto.randomUUID()}`;
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'invalid_json' }); }
      const validated = validateCommand(body);
      if (!validated.ok) return sendJson(res, 400, { error: 'invalid_command', message: validated.error });
      const hash = crypto.createHash('sha256').update(JSON.stringify(validated.command)).digest('hex');
      const result = executeCommand(ctx.db, validated.command, opId, hash, null, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);
      if (result.status === 200 && result.changed) broadcast(result.body);
      return sendJson(res, result.status, result.body);
    }

    // 10. Donations & Manual Entry & Reset Added & Soft-Delete
    if (req.method === 'GET' && p === '/api/donations') {
      const limit = Number(url.searchParams.get('limit') || 150);
      return sendJson(res, 200, {
        baseCurrency: ctx.profile.baseCurrency,
        ...readDonationHistory(ctx.db, { limit }),
      });
    }
    if (req.method === 'POST' && p === '/api/donations/manual') {
      const opId = typeof req.headers['x-operation-id'] === 'string' && OP_ID_RE.test(req.headers['x-operation-id'])
        ? req.headers['x-operation-id']
        : `man-${crypto.randomUUID()}`;
      const body = JSON.parse(await readBody(req) || '{}');
      const txType = typeof body.txType === 'string' ? body.txType : 'cash_tip';
      const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim().slice(0, 40) : 'Manual';
      const gifterName = typeof body.gifterName === 'string' && body.gifterName.trim() ? body.gifterName.trim().slice(0, 120) : 'Anonymous';
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
      const rules = readDonationRules(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);

      let resolved;
      let originalAmount = null;
      let originalCurrency = ctx.profile.baseCurrency;
      let tierOrLevel = null;

      if (txType === 'cash_tip' || txType === 'yt_superchat') {
        const amt = Number(body.amount);
        if (!Number.isFinite(amt) || amt <= 0) return sendJson(res, 400, { error: 'invalid_amount' });
        originalCurrency = typeof body.currency === 'string' && /^[A-Z]{3}$/i.test(body.currency.trim())
          ? body.currency.trim().toUpperCase()
          : ctx.profile.baseCurrency;
        originalAmount = amt;
        resolved = resolveTransactionCredit({ kind: txType, amount: amt, currency: originalCurrency }, rules, ctx.fx);
      } else {
        const qty = Number(body.quantity ?? body.units ?? 1);
        if (!Number.isFinite(qty) || qty <= 0) return sendJson(res, 400, { error: 'invalid_quantity' });
        resolved = resolveTransactionCredit({
          kind: txType,
          tierKey: body.tierKey,
          levelName: body.levelName,
          quantity: qty,
          units: qty,
        }, rules, ctx.fx);
        tierOrLevel = resolved.resolvedLabel;
      }

      const result = applyNormalizedDonation({
        eventId: opId,
        provider,
        grossAmount: resolved.grossAmount,
        creditMs: resolved.creditMs,
        payload: {
          gifterName,
          message,
          originalAmount,
          originalCurrency,
          txType,
          tierOrLevel,
          units: resolved.units,
          timerEnabled: resolved.timerEnabled,
        },
      });
      if (result.status !== 200) return sendJson(res, result.status, result.body);
      return sendJson(res, 200, {
        ok: true,
        eventId: opId,
        grossAmount: resolved.grossAmount,
        baseCurrency: ctx.profile.baseCurrency,
        creditMs: resolved.creditMs,
        timerEnabled: resolved.timerEnabled,
        ...result.body,
      });
    }
    if (req.method === 'POST' && p === '/api/donations/delete') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(body.eventIds) || body.eventIds.length === 0) {
        return sendJson(res, 400, { error: 'invalid_event_ids' });
      }
      const result = deleteDonations(ctx.db, {
        eventIds: body.eventIds,
        subtractFromTimer: body.subtractFromTimer === true,
      });
      if (result.changed && result.snapshot) broadcast(result.snapshot);
      broadcastOverlayTotals();
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'POST' && p === '/api/stats/reset-added') {
      const result = resetAddedCounter(ctx.db);
      broadcastOverlayTotals();
      return sendJson(res, 200, { ok: true, ...result });
    }

    // 11. Rules & Channel Pricing Catalog
    if (req.method === 'GET' && p === '/api/rules') {
      return sendJson(res, 200, readDonationRules(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd));
    }
    if (req.method === 'PUT' && p === '/api/rules') {
      const body = JSON.parse(await readBody(req) || '{}');
      const saved = updateDonationRules(ctx.db, body, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);
      return sendJson(res, 200, saved);
    }

    // 12. OBS Overlay Config
    if (req.method === 'GET' && p === '/api/overlay-config') {
      const cfg = readOverlayConfig(ctx.db);
      const hist = readDonationHistory(ctx.db, { limit: 1 });
      return sendJson(res, 200, { ...cfg, totalCreditMs: hist.stats.totalCreditMs, baseCurrency: ctx.profile.baseCurrency });
    }
    if (req.method === 'PUT' && p === '/api/overlay-config') {
      const body = JSON.parse(await readBody(req) || '{}');
      const saved = updateOverlayConfig(ctx.db, body);
      broadcastOverlayTotals();
      return sendJson(res, 200, saved);
    }

    // 13. Global Integrations Hub (Sockets + All Regional Webhooks)
    if (req.method === 'GET' && p === '/api/integrations') {
      const stored = readAllIntegrationConfigs(ctx.db);
      const maskedConfigs = {};
      for (const plat of DONATION_PLATFORMS) {
        const s = stored[plat.id] || {};
        maskedConfigs[plat.id] = {
          enabled: Boolean(s.enabled),
          hasCredentials: Boolean(s.socketToken || s.jwtToken || s.channelId || s.apiKey || s.accessToken || s.webhookSecret || s.verificationToken || s.signingSecret || s.clientSecret),
          username: s.username || '',
          channelId: s.channelId || '',
          filters: plat.id === 'streamlabs' ? sanitizeStreamlabsFilters(s.filters) : undefined,
        };
      }
      return sendJson(res, 200, {
        obs: {
          sourcePath: '/source',
          profileId: ctx.profile.id,
          readToken: ctx.profile.readToken,
          connectedSources: clientStats().obs,
        },
        webhookSecret: ctx.profile.webhookSecret,
        tunnel: tunnelManager.getStatus(),
        sockets: allSocketStatuses(),
        configs: maskedConfigs,
        lastWebhooks: lastWebhookByProvider,
        selectedPlatforms: ctx.profile.donationPlatforms,
        platforms: DONATION_PLATFORMS,
      });
    }
    if (req.method === 'PUT' && p.startsWith('/api/integrations/')) {
      const platId = decodeURIComponent(p.slice('/api/integrations/'.length)).toLowerCase();
      if (!PLATFORM_BY_ID[platId]) return sendJson(res, 404, { error: 'unknown_platform' });
      const body = JSON.parse(await readBody(req) || '{}');
      const prev = readIntegrationConfig(ctx.db, platId) || {};
      const next = { ...prev };
      if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
      for (const field of ['socketToken', 'jwtToken', 'channelId', 'testChannelId', 'apiKey', 'username', 'accessToken', 'webhookSecret', 'verificationToken', 'signingSecret', 'clientSecret']) {
        if (typeof body[field] === 'string' && body[field].trim()) next[field] = body[field].trim().slice(0, 2048);
      }
      if (body.clearToken === true) {
        for (const field of ['socketToken', 'jwtToken', 'apiKey', 'accessToken', 'webhookSecret', 'verificationToken', 'signingSecret', 'clientSecret']) delete next[field];
        if (PLATFORM_BY_ID[platId]?.protocol === 'socket') next.enabled = false;
      }
      if (platId === 'streamlabs' && body.filters) {
        next.filters = sanitizeStreamlabsFilters(body.filters, prev.filters || DEFAULT_STREAMLABS_FILTERS);
      }
      updateIntegrationConfig(ctx.db, platId, next);
      syncSocketsForActiveProfile();
      return sendJson(res, 200, { ok: true, provider: platId, sockets: allSocketStatuses() });
    }
    if (req.method === 'POST' && p === '/api/integrations/streamlabs/test') {
      const body = JSON.parse(await readBody(req) || '{}');
      const opId = `sl-test-${crypto.randomUUID()}`;
      const envelope = buildSyntheticStreamlabsEvent({
        eventType: body.eventType || 'donation',
        gifterName: body.gifterName,
        amount: body.amount,
        currency: body.currency || ctx.profile.baseCurrency,
        tierKey: body.tierKey,
        levelName: body.levelName,
        opId,
      });
      const applied = applyStreamlabsEnvelope(envelope, streamlabsClient.getStatus().filters);
      if (applied.length === 0) return sendJson(res, 200, { ok: true, filteredOut: true, creditMs: 0 });
      return sendJson(res, applied[0].status, { ok: applied[0].status === 200, ...applied[0] });
    }

    // 14. Dynamic Webhook Ingest & Built-In Tester (all 11 webhook platforms)
    //     Preferred URL: POST /api/ingest/<provider>/<urlToken>
    //     Ping check:    GET|HEAD /api/ingest/<provider>/<urlToken>
    //     Legacy compat: POST /api/ingest/<provider>
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/api/ingest/')) {
      const segs = p.slice('/api/ingest/'.length).split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      const provId = (segs[0] || '').toLowerCase();
      if (!PLATFORM_BY_ID[provId]) return sendJson(res, 404, { error: 'unknown_provider' });
      return sendJson(res, 200, { ok: true, provider: provId, ready: true });
    }
    if (req.method === 'POST' && p.startsWith('/api/ingest/')) {
      const segs = p.slice('/api/ingest/'.length).split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      const provId = (segs[0] || '').toLowerCase();
      const urlToken = segs[1] || url.searchParams.get('token') || '';
      const rawBody = await readBody(req);
      const storedCfg = readIntegrationConfig(ctx.db, provId) || {};
      const platformSecret = storedCfg.webhookSecret || storedCfg.verificationToken || storedCfg.signingSecret || storedCfg.clientSecret || '';
      const urlTokenValid = Boolean(urlToken && urlToken === ctx.profile.webhookSecret);
      // Legacy fallback: if hitting /api/ingest/<provider> directly without urlToken and no platformSecret,
      // allow profile.webhookSecret header verification (preserves unit test & existing relay compatibility).
      const effectiveSecret = platformSecret || (urlTokenValid ? '' : ctx.profile.webhookSecret);
      const rules = readDonationRules(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);
      const parsed = parseWebhookRequest({
        providerId: provId,
        rawBody,
        headers: req.headers,
        platformSecret: effectiveSecret,
        urlTokenValid,
        rulesConfig: rules,
        fxState: ctx.fx,
      });
      if (!parsed.ok) {
        lastWebhookByProvider[provId] = { receivedAtMs: nowMs(), ok: false, error: parsed.error };
        broadcastEvent('activity', { provider: provId, ok: false, error: parsed.error });
        return sendJson(res, parsed.status, { error: parsed.error });
      }
      const result = applyNormalizedDonation(parsed.event);
      lastWebhookByProvider[provId] = {
        receivedAtMs: nowMs(),
        ok: result.status === 200,
        gifterName: parsed.event.payload.gifterName,
        originalAmount: parsed.event.payload.originalAmount,
        originalCurrency: parsed.event.payload.originalCurrency,
        creditMs: parsed.event.creditMs,
      };
      return sendJson(res, result.status, { ok: result.status === 200, eventId: parsed.event.eventId, grossAmount: parsed.event.grossAmount, creditMs: parsed.event.creditMs, ...result.body });
    }
    if (req.method === 'POST' && p === '/api/webhooks/test') {
      const body = JSON.parse(await readBody(req) || '{}');
      const provId = String(body.provider || 'tako').toLowerCase();
      const meta = PLATFORM_BY_ID[provId];
      if (!meta) return sendJson(res, 400, { error: 'unknown_provider' });
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return sendJson(res, 400, { error: 'invalid_amount' });
      const currency = String(body.currency || meta.defaultCurrency || ctx.profile.baseCurrency).toUpperCase();
      const storedCfg = readIntegrationConfig(ctx.db, provId) || {};
      const platformSecret = storedCfg.webhookSecret || storedCfg.verificationToken || storedCfg.signingSecret || storedCfg.clientSecret || '';
      const donor = body.gifterName || 'Webhook Tester';
      const msg = body.message || `Test ${meta.name} donation`;
      const txId = `test-${provId}-${crypto.randomUUID()}`;

      // Build authentic real-world payload & headers matching each platform's exact spec
      let rawPayload;
      const testHeaders = { 'content-type': 'application/json' };
      if (provId === 'kofi') {
        const inner = JSON.stringify({
          verification_token: platformSecret || 'test-kofi-tok',
          kofi_transaction_id: txId,
          type: 'Donation',
          from_name: donor,
          amount: String(amount),
          currency,
          message: msg,
        });
        rawPayload = `data=${encodeURIComponent(inner)}`;
        testHeaders['content-type'] = 'application/x-www-form-urlencoded';
      } else if (provId === 'buymeacoffee') {
        rawPayload = JSON.stringify({
          response: { support_id: txId, supporter_name: donor, total_amount: String(amount), currency, support_note: msg },
        });
      } else if (provId === 'livepix') {
        rawPayload = JSON.stringify({
          id: txId, username: donor, message: msg, amount: Math.round(amount * 100), currency,
        });
      } else if (provId === 'saweria') {
        rawPayload = JSON.stringify({
          version: '2022.01', id: txId, type: 'donation', amount_raw: amount, cut: Math.round(amount * 0.05), donator_name: donor, message: msg,
        });
      } else if (provId === 'tiltify') {
        rawPayload = JSON.stringify({
          data: { id: txId, donor_name: donor, donor_comment: msg, amount: { value: String(amount), currency } },
        });
      } else if (provId === 'trakteer') {
        rawPayload = JSON.stringify({
          transaction_id: txId, type: 'tip', supporter_name: donor, supporter_message: msg, price: amount, quantity: 1,
        });
      } else if (provId === 'tako') {
        rawPayload = JSON.stringify({
          id: txId, gifterName: donor, amount, currency, message: msg,
        });
      } else {
        rawPayload = JSON.stringify({
          id: txId, gifterName: donor, supporter: donor, nickname: donor, amount, payAmount: amount, TradeAmt: amount, currency, message: msg,
        });
      }

      if (platformSecret) {
        const ts = String(Math.floor(Date.now() / 1000));
        const hmacHex = crypto.createHmac('sha256', platformSecret).update(rawPayload).digest('hex');
        const tiltB64 = crypto.createHmac('sha256', platformSecret).update(`${ts}.${rawPayload}`).digest('base64');
        testHeaders[`x-${provId}-signature`] = hmacHex;
        testHeaders['x-tako-signature'] = hmacHex;
        testHeaders['x-signature-sha256'] = hmacHex;
        testHeaders['x-tiltify-timestamp'] = ts;
        testHeaders['x-tiltify-signature'] = tiltB64;
        testHeaders['chzzk-event-signature'] = hmacHex;
        testHeaders['x-webhook-token'] = platformSecret;
        testHeaders['x-sociabuzz-token'] = platformSecret;
      }

      const rules = readDonationRules(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd);
      const parsed = parseWebhookRequest({
        providerId: provId,
        rawBody: rawPayload,
        headers: testHeaders,
        platformSecret,
        urlTokenValid: true,
        rulesConfig: rules,
        fxState: ctx.fx,
      });
      if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
      const result = applyNormalizedDonation(parsed.event);
      lastWebhookByProvider[provId] = {
        receivedAtMs: nowMs(),
        ok: result.status === 200,
        gifterName: parsed.event.payload.gifterName,
        originalAmount: parsed.event.payload.originalAmount,
        originalCurrency: parsed.event.payload.originalCurrency,
        creditMs: parsed.event.creditMs,
      };
      return sendJson(res, result.status, { ok: result.status === 200, provider: provId, eventId: parsed.event.eventId, grossAmount: parsed.event.grossAmount, creditMs: parsed.event.creditMs, ...result.body });
    }

    // 15. Finance & Revenue Accounting (Dynamic Base Currency + 5-Format Exports)
    if (req.method === 'GET' && p === '/api/finance/report') {
      return sendJson(res, 200, readFinanceReport(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd, parseFinanceFilters(url)));
    }
    if (req.method === 'GET' && p === '/api/finance/export') {
      const filters = parseFinanceFilters(url);
      filters.limit = 10_000;
      const report = readFinanceReport(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd, filters);
      const fmt = String(url.searchParams.get('format') || 'csv').toLowerCase();
      const slug = String(report.scope.label || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 36) || 'report';
      const stamp = new Date().toISOString().slice(0, 10);

      if (fmt === 'xlsx') {
        const buf = exportFinanceXlsx(report);
        res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="stream-finance-${slug}-${stamp}.xlsx"`, 'content-length': buf.length, 'cache-control': 'no-store' });
        return res.end(buf);
      }
      if (fmt === 'json') {
        const out = exportFinanceJson(report);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="stream-finance-${slug}-${stamp}.json"`, 'content-length': Buffer.byteLength(out), 'cache-control': 'no-store' });
        return res.end(out);
      }
      if (fmt === 'md' || fmt === 'markdown') {
        const out = exportFinanceMarkdown(report);
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="stream-finance-${slug}-${stamp}.md"`, 'content-length': Buffer.byteLength(out), 'cache-control': 'no-store' });
        return res.end(out);
      }
      if (fmt === 'html' || fmt === 'pdf' || fmt === 'print') {
        const out = exportFinanceHtmlReport(report);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `inline; filename="stream-finance-${slug}-${stamp}.html"`, 'content-length': Buffer.byteLength(out), 'cache-control': 'no-store' });
        return res.end(out);
      }
      const out = exportFinanceCsv(report);
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="stream-finance-${slug}-${stamp}.csv"`, 'content-length': Buffer.byteLength(out), 'cache-control': 'no-store' });
      return res.end(out);
    }
    if (req.method === 'GET' && p === '/api/finance/config') {
      return sendJson(res, 200, readFinanceConfig(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd));
    }
    if (req.method === 'PUT' && p === '/api/finance/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      return sendJson(res, 200, updateFinanceConfig(ctx.db, body, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd));
    }
    if (req.method === 'POST' && p === '/api/finance/sessions/reset') {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = startNewFinanceSession(ctx.db, body);
      if (result.alsoResetAdded) broadcastOverlayTotals();
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'PATCH' && p === '/api/finance/sessions') {
      const body = JSON.parse(await readBody(req) || '{}');
      const updated = updateFinanceSessionMeta(ctx.db, body);
      if (!updated) return sendJson(res, 404, { error: 'session_not_found' });
      return sendJson(res, 200, { ok: true, session: updated });
    }
    if (req.method === 'POST' && p === '/api/finance/recalculate') {
      const body = JSON.parse(await readBody(req) || '{}');
      const scope = body.scope === 'all' ? 'all' : 'current';
      return sendJson(res, 200, { ok: true, ...recalculateFinanceSnapshots(ctx.db, ctx.profile.baseCurrency, ctx.fx.ratesPerUsd, { scope }) });
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err && err.status) return sendJson(res, err.status, { error: 'request_failed', message: err.message });
    log('server_error', { message: String(err && err.message || err) });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  }
});

// Boot sockets & FX scheduler
syncSocketsForActiveProfile();
fxScheduler.start();

function listenWithFallback(candidates) {
  const [port, ...rest] = candidates;
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      const retryable = err.code === 'EADDRINUSE' || err.code === 'EACCES';
      if (retryable && rest.length > 0 && process.env.STRICT_PORT !== '1') {
        server.off('error', onErr);
        listenWithFallback(rest).then(resolve, reject);
        return;
      }
      reject(err);
    };
    server.once('error', onErr);
    server.listen(port, HOST, () => {
      server.off('error', onErr);
      boundPort = server.address().port;
      resolve(boundPort);
    });
  });
}

const portPlan = REQUESTED_PORT === 0
  ? [0]
  : [...new Set([REQUESTED_PORT, 47120, 47121, 47122, 38120, 0])];
await listenWithFallback(portPlan);
log('listen', { host: HOST, port: boundPort, dataDir: store.dataDir, node: process.version, pid: process.pid });

function shutdown() {
  stopAllSockets();
  fxScheduler.stop();
  tunnelManager.stop();
  store.closeAll();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
