// Atomic SQLite WAL Mutation Boundary (BEGIN IMMEDIATE).
//
// Preserves 100% of anti-drift invariants:
//   - Single serialization lock (BEGIN IMMEDIATE)
//   - Durable idempotency receipt checked FIRST (replay 200 / conflict 409)
//   - Timer state, receipt, donation event, and locked finance breakdown
//     snapshot commit in ONE atomic SQLite WAL transaction.

import crypto from 'node:crypto';
import {
  applyCommand, snapshotOf, MAX_SAFE_MS,
  buildDefaultRulesForCurrency, normalizeRulesConfig,
} from './domain.js';
import {
  buildDefaultFinanceConfig, sanitizeFinanceConfig,
  resolveFinanceChannelKey, calculateFinanceBreakdown, buildFinanceReport,
} from './finance.js';
import { DEFAULT_OVERLAY_CONFIG } from './profiles.js';
import { nowMs } from './clock.js';

function withImmediateTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function rowToState(row) {
  return {
    state: row.state,
    deadlineMs: row.deadline_ms === null ? null : Number(row.deadline_ms),
    pausedRemainingMs: row.paused_remaining_ms === null ? null : Number(row.paused_remaining_ms),
    revision: Number(row.revision),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function readState(db) {
  const row = db.prepare('SELECT state, deadline_ms, paused_remaining_ms, revision, updated_at_ms FROM timer_state WHERE id = 1').get();
  if (!row) throw new Error('timer_state is not seeded');
  return rowToState(row);
}

export function readSnapshot(db) {
  return snapshotOf(readState(db), nowMs());
}

export function readDonationRules(db, baseCurrency, ratesPerUsd) {
  const row = db.prepare('SELECT mode, tiers_json, event_rules_json, updated_at_ms FROM timer_rule_config WHERE id = 1').get();
  if (!row) return { ...buildDefaultRulesForCurrency(baseCurrency, ratesPerUsd), updatedAtMs: 0 };
  const norm = normalizeRulesConfig({
    baseCurrency,
    mode: row.mode,
    tiers: JSON.parse(row.tiers_json),
    eventRules: JSON.parse(row.event_rules_json),
  }, baseCurrency, ratesPerUsd);
  return { ...norm, updatedAtMs: Number(row.updated_at_ms) };
}

export function updateDonationRules(db, rawRules, baseCurrency, ratesPerUsd) {
  const norm = normalizeRulesConfig(rawRules, baseCurrency, ratesPerUsd);
  const now = nowMs();
  db.prepare(
    `INSERT INTO timer_rule_config (id, mode, tiers_json, event_rules_json, updated_at_ms)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, tiers_json = excluded.tiers_json,
       event_rules_json = excluded.event_rules_json, updated_at_ms = excluded.updated_at_ms`,
  ).run(norm.mode, JSON.stringify(norm.tiers), JSON.stringify(norm.eventRules), now);
  return { ...norm, updatedAtMs: now };
}

export function readFinanceConfig(db, baseCurrency, ratesPerUsd) {
  const row = db.prepare('SELECT config_json, updated_at_ms FROM finance_config WHERE id = 1').get();
  if (!row) return { ...buildDefaultFinanceConfig(baseCurrency, ratesPerUsd), updatedAtMs: 0 };
  const parsed = JSON.parse(row.config_json);
  return { ...sanitizeFinanceConfig({ ...parsed, baseCurrency }, baseCurrency, ratesPerUsd), updatedAtMs: Number(row.updated_at_ms) };
}

export function updateFinanceConfig(db, rawPatch, baseCurrency, ratesPerUsd) {
  const cur = readFinanceConfig(db, baseCurrency, ratesPerUsd);
  const next = sanitizeFinanceConfig({ ...cur, ...rawPatch, baseCurrency }, baseCurrency, ratesPerUsd);
  const now = nowMs();
  db.prepare(
    `INSERT INTO finance_config (id, config_json, updated_at_ms) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at_ms = excluded.updated_at_ms`,
  ).run(JSON.stringify(next), now);
  return { ...next, updatedAtMs: now };
}

/**
 * Execute ONE authoritative timer mutation (and optional donation + locked finance snapshot).
 */
export function executeCommand(db, command, opId, requestHash, donation = null, baseCurrency = 'USD', ratesPerUsd = null) {
  return withImmediateTx(db, () => {
    const now = nowMs();

    // 1. Check durable idempotency receipt FIRST
    const prev = db.prepare('SELECT request_hash, result_json FROM timer_operation WHERE op_id = ?').get(opId);
    if (prev) {
      if (prev.request_hash === requestHash) {
        return { status: 200, body: JSON.parse(prev.result_json), replay: true, changed: false };
      }
      return {
        status: 409,
        body: { error: 'conflicting_operation', message: 'operation id already used with a different request body' },
        replay: false,
        changed: false,
      };
    }

    const current = readState(db);
    const { state: next, changed } = applyCommand(current, command, now);
    const resultState = changed ? next : current;

    for (const val of [resultState.deadlineMs, resultState.pausedRemainingMs]) {
      if (val !== null && (val < 0 || val > MAX_SAFE_MS)) {
        return {
          status: 422,
          body: { error: 'duration_out_of_range', message: 'resulting duration exceeds supported range' },
          replay: false,
          changed: false,
        };
      }
    }

    const body = snapshotOf(resultState, now);
    db.prepare(
      `INSERT INTO timer_operation (op_id, request_hash, command, applied_at_ms, result_revision, result_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(opId, requestHash, JSON.stringify(command), now, resultState.revision, JSON.stringify(body));

    if (donation) {
      const finCfg = readFinanceConfig(db, baseCurrency, ratesPerUsd);
      const basePayload = donation.payload && typeof donation.payload === 'object' ? donation.payload : {};
      const chanKey = resolveFinanceChannelKey(donation.provider, basePayload.txType);
      const finSnap = calculateFinanceBreakdown(donation.grossAmount, chanKey, finCfg);
      const storedPayload = { ...basePayload, finance: finSnap };
      db.prepare(
        `INSERT OR IGNORE INTO donation_event
         (event_id, provider, gross_amount, currency, credit_ms, applied_at_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(opId, donation.provider, donation.grossAmount, baseCurrency, donation.creditMs, now, JSON.stringify(storedPayload));
    }

    if (changed) {
      db.prepare(
        `UPDATE timer_state SET state = ?, deadline_ms = ?, paused_remaining_ms = ?, revision = ?, updated_at_ms = ?
         WHERE id = 1`,
      ).run(next.state, next.deadlineMs, next.pausedRemainingMs, next.revision, next.updatedAtMs);
    }

    return { status: 200, body, replay: false, changed };
  });
}

export function readDonationHistory(db, { limit = 100 } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
  const meta = db.prepare('SELECT credit_reset_at_ms FROM timer_session_meta WHERE id = 1').get();
  const creditResetAtMs = meta ? Number(meta.credit_reset_at_ms) : 0;

  const statsRow = db.prepare(
    `SELECT COUNT(*) AS total_count,
            COALESCE(SUM(CASE WHEN applied_at_ms > ? THEN credit_ms ELSE 0 END), 0) AS total_credit_ms,
            COALESCE(SUM(gross_amount), 0) AS total_gross
     FROM donation_event
     WHERE deleted_at_ms IS NULL`,
  ).get(creditResetAtMs);

  const rows = db.prepare(
    `SELECT event_id, provider, gross_amount, currency, credit_ms, applied_at_ms, payload_json
     FROM donation_event
     WHERE deleted_at_ms IS NULL
     ORDER BY applied_at_ms DESC, event_id DESC
     LIMIT ?`,
  ).all(safeLimit);

  return {
    stats: {
      totalCount: Number(statsRow?.total_count || 0),
      totalCreditMs: Number(statsRow?.total_credit_ms || 0),
      totalGross: Number(statsRow?.total_gross || 0),
      creditResetAtMs,
    },
    donations: rows.map((row) => {
      const payload = JSON.parse(row.payload_json || '{}');
      return {
        eventId: row.event_id,
        provider: row.provider,
        gifterName: typeof payload.gifterName === 'string' && payload.gifterName.trim() ? payload.gifterName.trim() : 'Anonymous',
        message: typeof payload.message === 'string' ? payload.message : '',
        grossAmount: Number(row.gross_amount) || 0,
        currency: row.currency,
        creditMs: Number(row.credit_ms) || 0,
        appliedAtMs: Number(row.applied_at_ms) || 0,
        units: typeof payload.units === 'number' ? payload.units : null,
        originalAmount: typeof payload.originalAmount === 'number' ? payload.originalAmount : null,
        originalCurrency: typeof payload.originalCurrency === 'string' ? payload.originalCurrency : null,
        tierOrLevel: typeof payload.tierOrLevel === 'string' ? payload.tierOrLevel : null,
      };
    }),
  };
}

export function resetAddedCounter(db) {
  const now = nowMs();
  const maxRow = db.prepare('SELECT COALESCE(MAX(applied_at_ms), 0) AS max_ts FROM donation_event').get();
  const watermark = Math.max(now, Number(maxRow?.max_ts || 0));
  db.prepare(
    `INSERT INTO timer_session_meta (id, credit_reset_at_ms, updated_at_ms) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET credit_reset_at_ms = MAX(credit_reset_at_ms, excluded.credit_reset_at_ms), updated_at_ms = excluded.updated_at_ms`,
  ).run(watermark, now);
  return { creditResetAtMs: watermark, stats: readDonationHistory(db, { limit: 1 }).stats };
}

export function deleteDonations(db, { eventIds, subtractFromTimer = false, opId = null }) {
  const ids = [...new Set(eventIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
  if (ids.length === 0) {
    return { deletedCount: 0, removedCreditMs: 0, subtractedFromTimer: false, changed: false, snapshot: null, stats: readDonationHistory(db, { limit: 1 }).stats };
  }
  return withImmediateTx(db, () => {
    const now = nowMs();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT event_id, credit_ms FROM donation_event WHERE deleted_at_ms IS NULL AND event_id IN (${placeholders})`,
    ).all(...ids);
    if (rows.length === 0) {
      return { deletedCount: 0, removedCreditMs: 0, subtractedFromTimer: false, changed: false, snapshot: null, stats: readDonationHistory(db, { limit: 1 }).stats };
    }
    const foundIds = rows.map((r) => r.event_id);
    const removedCreditMs = rows.reduce((s, r) => s + Math.max(0, Number(r.credit_ms) || 0), 0);
    const fp = foundIds.map(() => '?').join(',');
    db.prepare(`UPDATE donation_event SET deleted_at_ms = ? WHERE event_id IN (${fp})`).run(now, ...foundIds);

    let snapshot = null;
    let changed = false;
    if (subtractFromTimer && removedCreditMs > 0) {
      const current = readState(db);
      const applied = applyCommand(current, { type: 'subtract', amountMs: removedCreditMs }, now);
      changed = applied.changed;
      const resultState = changed ? applied.state : current;
      snapshot = snapshotOf(resultState, now);
      const subOpId = opId || `del-${crypto.randomUUID()}`;
      const hash = crypto.createHash('sha256').update(JSON.stringify({ deleted: foundIds.sort(), removedCreditMs })).digest('hex');
      db.prepare(
        `INSERT OR IGNORE INTO timer_operation (op_id, request_hash, command, applied_at_ms, result_revision, result_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(subOpId, hash, JSON.stringify({ type: 'subtract', amountMs: removedCreditMs }), now, resultState.revision, JSON.stringify(snapshot));
      if (changed) {
        db.prepare('UPDATE timer_state SET state=?, deadline_ms=?, paused_remaining_ms=?, revision=?, updated_at_ms=? WHERE id=1')
          .run(resultState.state, resultState.deadlineMs, resultState.pausedRemainingMs, resultState.revision, resultState.updatedAtMs);
      }
    }
    return {
      deletedCount: foundIds.length,
      removedCreditMs,
      subtractedFromTimer: Boolean(subtractFromTimer && removedCreditMs > 0),
      changed,
      snapshot,
      stats: readDonationHistory(db, { limit: 1 }).stats,
    };
  });
}

// -------------------------------------------------- overlay & integrations --

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_BG = new Set(['dark', 'transparent', 'chroma', 'color']);
const ALLOWED_POS = new Set(['bottom-left', 'bottom-right', 'top-left', 'top-right', 'center']);

export function readOverlayConfig(db) {
  const row = db.prepare('SELECT config_json, updated_at_ms FROM timer_overlay_config WHERE id = 1').get();
  if (!row) return { ...DEFAULT_OVERLAY_CONFIG, updatedAtMs: 0 };
  return { ...DEFAULT_OVERLAY_CONFIG, ...JSON.parse(row.config_json), updatedAtMs: Number(row.updated_at_ms) };
}

export function updateOverlayConfig(db, patch = {}) {
  const base = readOverlayConfig(db);
  const str = (v, max, fb) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fb);
  const bool = (v, fb) => (typeof v === 'boolean' ? v : fb);
  const hex = (v, fb) => (typeof v === 'string' && HEX_COLOR_RE.test(v.trim()) ? v.trim() : fb);
  const intR = (v, min, max, fb) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb);

  const next = {
    timerName: str(patch.timerName, 60, base.timerName),
    totalName: str(patch.totalName, 60, base.totalName),
    showTimer: bool(patch.showTimer, base.showTimer),
    showTotal: bool(patch.showTotal, base.showTotal),
    showRush: bool(patch.showRush, base.showRush),
    bgMode: ALLOWED_BG.has(patch.bgMode) ? patch.bgMode : base.bgMode,
    bgColor: hex(patch.bgColor, base.bgColor),
    textColor: hex(patch.textColor, base.textColor),
    accentColor: hex(patch.accentColor, base.accentColor),
    fontFamily: str(patch.fontFamily, 80, base.fontFamily),
    fontSize: intR(patch.fontSize, 16, 96, base.fontSize),
    position: ALLOWED_POS.has(patch.position) ? patch.position : base.position,
    opacity: intR(patch.opacity, 10, 100, base.opacity),
    popup: bool(patch.popup, base.popup),
    rushOn: bool(patch.rushOn, base.rushOn),
    rushLv: intR(patch.rushLv, 1, 10, base.rushLv),
  };
  const now = nowMs();
  db.prepare(
    `INSERT INTO timer_overlay_config (id, config_json, updated_at_ms) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at_ms = excluded.updated_at_ms`,
  ).run(JSON.stringify(next), now);
  return { ...next, updatedAtMs: now };
}

export function readIntegrationConfig(db, provider) {
  const row = db.prepare('SELECT config_json, updated_at_ms FROM integration_config WHERE provider = ?').get(provider);
  if (!row) return null;
  return { ...JSON.parse(row.config_json), updatedAtMs: Number(row.updated_at_ms) };
}

export function readAllIntegrationConfigs(db) {
  const rows = db.prepare('SELECT provider, config_json, updated_at_ms FROM integration_config').all();
  const out = {};
  for (const r of rows) out[r.provider] = { ...JSON.parse(r.config_json), updatedAtMs: Number(r.updated_at_ms) };
  return out;
}

export function updateIntegrationConfig(db, provider, cfgObj) {
  const now = nowMs();
  db.prepare(
    `INSERT INTO integration_config (provider, config_json, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET config_json = excluded.config_json, updated_at_ms = excluded.updated_at_ms`,
  ).run(provider, JSON.stringify(cfgObj), now);
  return { ...cfgObj, updatedAtMs: now };
}

// -------------------------------------------------- finance sessions & rep --

function mapSess(r) {
  return {
    sessionId: r.session_id,
    seqNum: Number(r.seq_num),
    label: r.label,
    notes: r.notes || '',
    startedAtMs: Number(r.started_at_ms),
    endedAtMs: r.ended_at_ms === null ? null : Number(r.ended_at_ms),
    createdAtMs: Number(r.created_at_ms),
  };
}

export function readFinanceSessions(db) {
  const rows = db.prepare('SELECT * FROM finance_session ORDER BY seq_num ASC').all();
  if (rows.length === 0) {
    return [{ sessionId: 'session-1', seqNum: 1, label: 'Session #1', notes: '', startedAtMs: 0, endedAtMs: null, createdAtMs: 0 }];
  }
  return rows.map(mapSess);
}

export function startNewFinanceSession(db, { closingLabel = '', closingNotes = '', nextLabel = '', nextNotes = '', alsoResetAdded = false } = {}) {
  return withImmediateTx(db, () => {
    const sessions = readFinanceSessions(db);
    const active = sessions.find((s) => s.endedAtMs === null) || sessions[sessions.length - 1];
    const maxSeq = sessions.reduce((m, s) => Math.max(m, s.seqNum), 0);
    const maxEv = db.prepare('SELECT COALESCE(MAX(applied_at_ms), 0) AS max_ts FROM donation_event').get();
    const maxEvTs = Number(maxEv?.max_ts || 0);
    const now = nowMs();
    const boundaryMs = Math.max(now, maxEvTs + 1, (active ? active.startedAtMs : 0) + 1);

    let closedSession = null;
    if (active) {
      const fLabel = typeof closingLabel === 'string' && closingLabel.trim() ? closingLabel.trim().slice(0, 80) : active.label;
      const fNotes = typeof closingNotes === 'string' && closingNotes.trim() ? closingNotes.trim().slice(0, 240) : active.notes;
      db.prepare('UPDATE finance_session SET ended_at_ms = ?, label = ?, notes = ? WHERE session_id = ?')
        .run(boundaryMs, fLabel, fNotes, active.sessionId);
      closedSession = { ...active, endedAtMs: boundaryMs, label: fLabel, notes: fNotes };
    }

    const nextSeq = maxSeq + 1;
    const newId = `session-${nextSeq}`;
    const nLabel = typeof nextLabel === 'string' && nextLabel.trim() ? nextLabel.trim().slice(0, 80) : `Session #${nextSeq}`;
    const nNotes = typeof nextNotes === 'string' ? nextNotes.trim().slice(0, 240) : '';
    db.prepare(
      `INSERT INTO finance_session (session_id, seq_num, label, notes, started_at_ms, ended_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(newId, nextSeq, nLabel, nNotes, boundaryMs, now);

    if (alsoResetAdded === true) {
      const wm = Math.max(now, maxEvTs);
      db.prepare(
        `INSERT INTO timer_session_meta (id, credit_reset_at_ms, updated_at_ms) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET credit_reset_at_ms = MAX(credit_reset_at_ms, excluded.credit_reset_at_ms), updated_at_ms = excluded.updated_at_ms`,
      ).run(wm, now);
    }

    return {
      closedSession,
      activeSession: { sessionId: newId, seqNum: nextSeq, label: nLabel, notes: nNotes, startedAtMs: boundaryMs, endedAtMs: null, createdAtMs: now },
      boundaryMs,
      alsoResetAdded: alsoResetAdded === true,
    };
  });
}

export function updateFinanceSessionMeta(db, { sessionId, label, notes }) {
  const cur = db.prepare('SELECT * FROM finance_session WHERE session_id = ?').get(sessionId);
  if (!cur) return null;
  const nLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : cur.label;
  const nNotes = typeof notes === 'string' ? notes.trim().slice(0, 240) : (cur.notes || '');
  db.prepare('UPDATE finance_session SET label = ?, notes = ? WHERE session_id = ?').run(nLabel, nNotes, sessionId);
  return mapSess({ ...cur, label: nLabel, notes: nNotes });
}

export function recalculateFinanceSnapshots(db, baseCurrency, ratesPerUsd, { scope = 'current' } = {}) {
  return withImmediateTx(db, () => {
    const cfg = readFinanceConfig(db, baseCurrency, ratesPerUsd);
    let rows;
    if (scope === 'current') {
      const active = db.prepare('SELECT started_at_ms FROM finance_session WHERE ended_at_ms IS NULL ORDER BY seq_num DESC LIMIT 1').get();
      const startMs = active ? Number(active.started_at_ms) : 0;
      rows = db.prepare('SELECT event_id, provider, gross_amount, payload_json FROM donation_event WHERE deleted_at_ms IS NULL AND applied_at_ms >= ?').all(startMs);
    } else {
      rows = db.prepare('SELECT event_id, provider, gross_amount, payload_json FROM donation_event WHERE deleted_at_ms IS NULL').all();
    }
    const upd = db.prepare('UPDATE donation_event SET payload_json = ? WHERE event_id = ?');
    let count = 0;
    for (const r of rows) {
      const payload = JSON.parse(r.payload_json || '{}');
      const chanKey = resolveFinanceChannelKey(r.provider, payload.txType);
      payload.finance = calculateFinanceBreakdown(Number(r.gross_amount) || 0, chanKey, cfg);
      upd.run(JSON.stringify(payload), r.event_id);
      count += 1;
    }
    return { updatedCount: count, scope };
  });
}

export function readFinanceReport(db, baseCurrency, ratesPerUsd, filters = {}) {
  const sessions = readFinanceSessions(db);
  const config = readFinanceConfig(db, baseCurrency, ratesPerUsd);
  const rows = db.prepare(
    `SELECT event_id, provider, gross_amount, currency, credit_ms, applied_at_ms, payload_json, deleted_at_ms
     FROM donation_event
     ORDER BY applied_at_ms DESC, event_id DESC`,
  ).all().map((r) => ({
    eventId: r.event_id,
    provider: r.provider,
    grossAmount: Number(r.gross_amount) || 0,
    currency: r.currency,
    creditMs: Number(r.credit_ms) || 0,
    appliedAtMs: Number(r.applied_at_ms) || 0,
    payload: JSON.parse(r.payload_json || '{}'),
    deletedAtMs: r.deleted_at_ms === null ? null : Number(r.deleted_at_ms),
  }));
  return buildFinanceReport(rows, sessions, config, filters);
}
