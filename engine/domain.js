// Pure timer & transaction credit domain. Zero I/O, deterministic clock argument.
//
// Canonical timer representation:
//   running -> deadlineMs          (UTC epoch ms when remaining hits zero)
//   paused  -> pausedRemainingMs   (frozen integer ms duration)
//
// Dynamic Base Currency:
//   Every profile chooses its own operating `baseCurrency` (USD, IDR, JPY, KRW,
//   EUR, GBP, SGD, MYR, TWD, BRL, etc.). All tier thresholds, YouTube custom
//   membership prices, Twitch tier prices, and cross-currency conversions operate
//   natively in that profile's `baseCurrency`.
//   Gross amount ALWAYS enters timer arithmetic; fees stay strictly in Finance.

import {
  BASELINE_RATES_PER_USD,
  convertCrossCurrency,
  roundCurrency,
} from './fx.js';

export const RUNNING = 'running';
export const PAUSED = 'paused';
export const MAX_SAFE_MS = Number.MAX_SAFE_INTEGER;

export function effectiveRemainingMs(state, nowMs) {
  if (state.state === RUNNING) return state.deadlineMs - nowMs;
  return state.pausedRemainingMs;
}

function withRemaining(state, remainingMs, nowMs) {
  if (state.state === RUNNING) {
    return {
      state: RUNNING,
      deadlineMs: nowMs + remainingMs,
      pausedRemainingMs: null,
      revision: state.revision + 1,
      updatedAtMs: nowMs,
    };
  }
  return {
    state: PAUSED,
    deadlineMs: null,
    pausedRemainingMs: remainingMs,
    revision: state.revision + 1,
    updatedAtMs: nowMs,
  };
}

function sameRepresentation(a, b) {
  return a.state === b.state
    && a.deadlineMs === b.deadlineMs
    && a.pausedRemainingMs === b.pausedRemainingMs;
}

export function applyCommand(state, command, nowMs) {
  const remaining = effectiveRemainingMs(state, nowMs);
  let next;

  switch (command.type) {
    case 'pause':
      next = state.state === PAUSED
        ? state
        : {
            state: PAUSED,
            deadlineMs: null,
            pausedRemainingMs: Math.max(0, remaining),
            revision: state.revision + 1,
            updatedAtMs: nowMs,
          };
      break;

    case 'resume':
      next = state.state === RUNNING
        ? state
        : {
            state: RUNNING,
            deadlineMs: nowMs + state.pausedRemainingMs,
            pausedRemainingMs: null,
            revision: state.revision + 1,
            updatedAtMs: nowMs,
          };
      break;

    case 'add':
      if (command.amountMs === 0) {
        next = state;
      } else if (state.state === RUNNING && state.deadlineMs > nowMs) {
        next = {
          state: RUNNING,
          deadlineMs: state.deadlineMs + command.amountMs,
          pausedRemainingMs: null,
          revision: state.revision + 1,
          updatedAtMs: nowMs,
        };
      } else {
        next = withRemaining(state, Math.max(0, remaining) + command.amountMs, nowMs);
      }
      break;

    case 'subtract':
      if (command.amountMs === 0 || (state.state === RUNNING && remaining <= 0)) {
        next = state;
      } else if (state.state === RUNNING) {
        next = {
          state: RUNNING,
          deadlineMs: Math.max(nowMs, state.deadlineMs - command.amountMs),
          pausedRemainingMs: null,
          revision: state.revision + 1,
          updatedAtMs: nowMs,
        };
      } else {
        next = withRemaining(state, Math.max(0, remaining - command.amountMs), nowMs);
      }
      break;

    case 'set':
      next = withRemaining(state, command.amountMs, nowMs);
      break;

    case 'reset':
      next = {
        state: PAUSED,
        deadlineMs: null,
        pausedRemainingMs: 0,
        revision: state.revision + 1,
        updatedAtMs: nowMs,
      };
      break;

    default:
      throw new Error(`unknown command type: ${command.type}`);
  }

  return { state: next, changed: !sameRepresentation(next, state) };
}

export function snapshotOf(state, nowMs) {
  return {
    revision: state.revision,
    state: state.state,
    remainingMs: effectiveRemainingMs(state, nowMs),
    serverTimeMs: nowMs,
  };
}

const COMMAND_TYPES = new Set(['pause', 'resume', 'add', 'subtract', 'set', 'reset']);
const AMOUNT_TYPES = new Set(['add', 'subtract', 'set']);

export function validateCommand(raw) {
  const fail = (message) => ({ ok: false, error: message });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('body must be a JSON object');
  }
  const { type } = raw;
  if (typeof type !== 'string' || !COMMAND_TYPES.has(type)) {
    return fail(`unknown command type: ${JSON.stringify(type)}`);
  }
  if (!AMOUNT_TYPES.has(type)) {
    if (raw.amountMs !== undefined) return fail(`amountMs is not accepted by ${type}`);
    return { ok: true, command: { type } };
  }
  const amount = raw.amountMs;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0 || amount > MAX_SAFE_MS) {
    return fail('amountMs must be a non-negative safe integer');
  }
  return { ok: true, command: { type, amountMs: amount } };
}

// -------------------------------------------- Dynamic Currency Presets ------

export const DEFAULT_TIMER_TRIGGERS = {
  cashTips: true,
  ytSuperchat: true,
  ytMember: true,
  ytGiftMember: true,
  ytJewels: true,
  twitchSub: true,
  twitchPrime: true,
  twitchGiftSub: true,
  twitchBits: true,
};

const CURRENCY_PRESETS = {
  USD: {
    tiers: [
      { minimumAmount: 50, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 10, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 2, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [4.99, 9.99, 24.99],
    twPrices: { prime: 4.99, '1000': 4.99, '2000': 9.99, '3000': 24.99 },
    unitPrice100: 1.00,
  },
  IDR: {
    tiers: [
      { minimumAmount: 500_000, creditMs: 15 * 3_600 * 1_000 },
      { minimumAmount: 100_000, creditMs: 2.5 * 3_600 * 1_000 },
      { minimumAmount: 10_000, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [10_000, 50_000, 100_000],
    twPrices: { prime: 32_000, '1000': 32_000, '2000': 64_000, '3000': 160_000 },
    unitPrice100: 16_000,
  },
  JPY: {
    tiers: [
      { minimumAmount: 10_000, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 2_000, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 300, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [490, 1190, 2990],
    twPrices: { prime: 700, '1000': 700, '2000': 1400, '3000': 3500 },
    unitPrice100: 155,
  },
  KRW: {
    tiers: [
      { minimumAmount: 50_000, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 10_000, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 2_000, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [4900, 12000, 30000],
    twPrices: { prime: 6500, '1000': 6500, '2000': 13000, '3000': 32500 },
    unitPrice100: 1380,
  },
  TWD: {
    tiers: [
      { minimumAmount: 1500, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 300, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 75, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [75, 300, 750],
    twPrices: { prime: 150, '1000': 150, '2000': 300, '3000': 750 },
    unitPrice100: 33,
  },
  EUR: {
    tiers: [
      { minimumAmount: 50, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 10, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 2, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [4.99, 9.99, 24.99],
    twPrices: { prime: 4.99, '1000': 4.99, '2000': 9.99, '3000': 24.99 },
    unitPrice100: 0.92,
  },
  GBP: {
    tiers: [
      { minimumAmount: 40, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 10, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 2, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [3.99, 8.99, 19.99],
    twPrices: { prime: 4.99, '1000': 4.99, '2000': 8.99, '3000': 19.99 },
    unitPrice100: 0.79,
  },
  BRL: {
    tiers: [
      { minimumAmount: 200, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 50, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 10, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [7.99, 19.99, 49.99],
    twPrices: { prime: 9.90, '1000': 9.90, '2000': 19.90, '3000': 49.90 },
    unitPrice100: 5.75,
  },
  SGD: {
    tiers: [
      { minimumAmount: 50, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 10, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 2, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [4.98, 12.98, 29.98],
    twPrices: { prime: 6.98, '1000': 6.98, '2000': 13.98, '3000': 34.98 },
    unitPrice100: 1.34,
  },
  MYR: {
    tiers: [
      { minimumAmount: 200, creditMs: 5 * 3_600 * 1_000 },
      { minimumAmount: 40, creditMs: 60 * 60 * 1_000 },
      { minimumAmount: 10, creditMs: 10 * 60 * 1_000 },
    ],
    ytPrices: [10, 30, 80],
    twPrices: { prime: 15, '1000': 15, '2000': 30, '3000': 75 },
    unitPrice100: 4.45,
  },
};

function niceScale(usdAmount, code, rates = BASELINE_RATES_PER_USD) {
  const raw = convertCrossCurrency(usdAmount, 'USD', code, rates);
  if (raw >= 10_000) return Math.round(raw / 1000) * 1000;
  if (raw >= 1_000) return Math.round(raw / 100) * 100;
  if (raw >= 100) return Math.round(raw / 10) * 10;
  return roundCurrency(raw, code);
}

/** Build sensible default donation tiers, YT levels, Twitch tiers, and virtual rates in ANY baseCurrency. */
export function buildDefaultRulesForCurrency(baseCurrency = 'USD', rates = BASELINE_RATES_PER_USD) {
  const cur = String(baseCurrency || 'USD').trim().toUpperCase();
  const preset = CURRENCY_PRESETS[cur];
  const tiers = preset
    ? preset.tiers.map((t) => ({ ...t }))
    : [
        { minimumAmount: niceScale(50, cur, rates), creditMs: 5 * 3_600 * 1_000 },
        { minimumAmount: niceScale(10, cur, rates), creditMs: 60 * 60 * 1_000 },
        { minimumAmount: niceScale(2, cur, rates), creditMs: 10 * 60 * 1_000 },
      ];
  const ytPrices = preset ? preset.ytPrices : [niceScale(5, cur, rates), niceScale(15, cur, rates), niceScale(30, cur, rates)];
  const twPrices = preset
    ? preset.twPrices
    : {
        prime: niceScale(5, cur, rates),
        '1000': niceScale(5, cur, rates),
        '2000': niceScale(10, cur, rates),
        '3000': niceScale(25, cur, rates),
      };
  const u100 = preset ? preset.unitPrice100 : niceScale(1, cur, rates);

  return {
    baseCurrency: cur,
    mode: 'threshold',
    tiers,
    eventRules: {
      timerTriggers: { ...DEFAULT_TIMER_TRIGGERS },
      ytLevels: [
        { id: 'yt-supporter', name: 'Supporter', price: ytPrices[0], creditMode: 'fixed_time', fixedMs: 5 * 60 * 1_000, isDefault: true },
        { id: 'yt-vip', name: 'VIP', price: ytPrices[1], creditMode: 'follow_tiers', fixedMs: 15 * 60 * 1_000, isDefault: false },
        { id: 'yt-sultan', name: 'Champion', price: ytPrices[2], creditMode: 'follow_tiers', fixedMs: 60 * 60 * 1_000, isDefault: false },
      ],
      twitchTiers: {
        prime: { label: 'Prime', price: twPrices.prime, creditMode: 'fixed_time', fixedMs: 5 * 60 * 1_000 },
        '1000': { label: 'Tier 1', price: twPrices['1000'], creditMode: 'fixed_time', fixedMs: 5 * 60 * 1_000 },
        '2000': { label: 'Tier 2', price: twPrices['2000'], creditMode: 'fixed_time', fixedMs: 10 * 60 * 1_000 },
        '3000': { label: 'Tier 3', price: twPrices['3000'], creditMode: 'fixed_time', fixedMs: 25 * 60 * 1_000 },
      },
      virtualRates: {
        ytJewels: { perUnit: 100, pricePerUnit: u100, creditMode: 'fixed_time', unitMs: 2 * 60 * 1_000 },
        twitchBits: { perUnit: 100, pricePerUnit: u100, creditMode: 'fixed_time', unitMs: 2 * 60 * 1_000 },
      },
    },
  };
}

export function normalizeTwitchPlanKey(rawPlan) {
  const s = String(rawPlan ?? '1000').trim().toLowerCase();
  if (s === 'prime') return 'prime';
  if (s === '2000' || s === 'tier 2' || s === 'tier2' || s === '2') return '2000';
  if (s === '3000' || s === 'tier 3' || s === 'tier3' || s === '3') return '3000';
  return '1000';
}

const RULE_MODES = new Set(['threshold', 'greedy']);
const CREDIT_MODES = new Set(['follow_tiers', 'fixed_time']);

export function normalizeRulesConfig(raw, baseCurrency = 'USD', rates = BASELINE_RATES_PER_USD) {
  const cur = String(raw?.baseCurrency || baseCurrency || 'USD').trim().toUpperCase();
  const def = buildDefaultRulesForCurrency(cur, rates);
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = RULE_MODES.has(src.mode) ? src.mode : def.mode;

  const rawTiers = Array.isArray(src.tiers) && src.tiers.length > 0 ? src.tiers : def.tiers;
  const seenMin = new Set();
  const tiers = [];
  for (const t of rawTiers) {
    if (!t || typeof t !== 'object') continue;
    const minAmt = roundCurrency(Number(t.minimumAmount ?? t.minimumIdr), cur);
    const creditMs = Math.round(Number(t.creditMs));
    if (!Number.isFinite(minAmt) || minAmt <= 0 || !Number.isFinite(creditMs) || creditMs <= 0) continue;
    if (seenMin.has(minAmt)) continue;
    seenMin.add(minAmt);
    tiers.push({ minimumAmount: minAmt, creditMs: Math.min(MAX_SAFE_MS, creditMs) });
  }
  tiers.sort((a, b) => b.minimumAmount - a.minimumAmount);

  const srcEv = src.eventRules && typeof src.eventRules === 'object' ? src.eventRules : {};
  const srcTr = srcEv.timerTriggers && typeof srcEv.timerTriggers === 'object' ? srcEv.timerTriggers : {};
  const timerTriggers = {};
  for (const k of Object.keys(DEFAULT_TIMER_TRIGGERS)) {
    timerTriggers[k] = typeof srcTr[k] === 'boolean' ? srcTr[k] : true;
  }

  // YouTube levels
  const rawLevels = Array.isArray(srcEv.ytLevels) && srcEv.ytLevels.length > 0 ? srcEv.ytLevels : def.eventRules.ytLevels;
  const seenLvl = new Set();
  const ytLevels = [];
  for (let i = 0; i < Math.min(20, rawLevels.length); i += 1) {
    const l = rawLevels[i];
    if (!l || typeof l !== 'object') continue;
    const name = typeof l.name === 'string' && l.name.trim() ? l.name.trim().slice(0, 60) : '';
    if (!name || seenLvl.has(name.toLowerCase())) continue;
    seenLvl.add(name.toLowerCase());
    const price = Math.max(0, roundCurrency(Number(l.price ?? l.priceIdr ?? 0), cur));
    const creditMode = CREDIT_MODES.has(l.creditMode) ? l.creditMode : 'fixed_time';
    const fixedMs = Math.max(0, Math.round(Number(l.fixedMs ?? 300_000) || 0));
    const id = typeof l.id === 'string' && l.id.trim() ? l.id.trim().slice(0, 48) : `yt-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || i}`;
    ytLevels.push({ id, name, price, creditMode, fixedMs, isDefault: Boolean(l.isDefault) });
  }
  if (ytLevels.length === 0) ytLevels.push(...def.eventRules.ytLevels);
  if (!ytLevels.some((l) => l.isDefault)) ytLevels[0].isDefault = true;

  // Twitch tiers
  const twitchTiers = {};
  for (const key of ['prime', '1000', '2000', '3000']) {
    const d = def.eventRules.twitchTiers[key];
    const r = srcEv.twitchTiers?.[key] || {};
    twitchTiers[key] = {
      label: d.label,
      price: Math.max(0, roundCurrency(Number(r.price ?? r.priceIdr ?? d.price), cur)),
      creditMode: CREDIT_MODES.has(r.creditMode) ? r.creditMode : d.creditMode,
      fixedMs: Math.max(0, Math.round(Number(r.fixedMs ?? d.fixedMs) || 0)),
    };
  }

  // Virtual units
  const virtualRates = {};
  for (const key of ['ytJewels', 'twitchBits']) {
    const d = def.eventRules.virtualRates[key];
    const r = srcEv.virtualRates?.[key] || {};
    virtualRates[key] = {
      perUnit: Math.max(1, Math.trunc(Number(r.perUnit ?? d.perUnit) || d.perUnit)),
      pricePerUnit: Math.max(0, roundCurrency(Number(r.pricePerUnit ?? r.pricePerUnitIdr ?? d.pricePerUnit), cur)),
      creditMode: CREDIT_MODES.has(r.creditMode) ? r.creditMode : d.creditMode,
      unitMs: Math.max(0, Math.round(Number(r.unitMs ?? d.unitMs) || 0)),
    };
  }

  return {
    baseCurrency: cur,
    mode,
    tiers: tiers.length > 0 ? tiers : def.tiers,
    eventRules: { timerTriggers, ytLevels, twitchTiers, virtualRates },
  };
}

/** Compute timer credit (ms) from a gross amount in the profile's `baseCurrency`. */
export function creditForAmount(grossBaseAmount, rulesConfig) {
  const amt = Number(grossBaseAmount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  const sorted = [...(rulesConfig.tiers || [])].sort((a, b) => b.minimumAmount - a.minimumAmount);
  if (rulesConfig.mode === 'greedy') {
    // Work in integer hundredths so decimal currencies ($10.00 / $2.50) never lose precision
    let remainingCents = Math.round(amt * 100);
    let total = 0;
    for (const tier of sorted) {
      const minCents = Math.round(tier.minimumAmount * 100);
      if (minCents > 0 && remainingCents >= minCents) {
        const count = Math.floor(remainingCents / minCents);
        total += count * tier.creditMs;
        remainingCents -= count * minCents;
      }
    }
    return Math.min(MAX_SAFE_MS, total);
  }
  for (const tier of sorted) {
    if (amt + 1e-9 >= tier.minimumAmount) return tier.creditMs;
  }
  return 0;
}

/**
 * Unified transaction resolver shared by Manual Entry, Webhooks, and ALL Live Sockets.
 * Resolves exact gross amount in the profile's `baseCurrency` AND timer credit ms.
 */
export function resolveTransactionCredit(tx, rulesConfig, fxState = { ratesPerUsd: BASELINE_RATES_PER_USD, autoUpdate: true }) {
  const cfg = rulesConfig;
  const baseCur = cfg.baseCurrency || 'USD';
  const ev = cfg.eventRules;
  const triggers = ev.timerTriggers;
  const kind = String(tx.kind || 'cash_tip');
  const rates = fxState?.ratesPerUsd || BASELINE_RATES_PER_USD;

  if (kind === 'cash_tip' || kind === 'yt_superchat') {
    const enabled = kind === 'yt_superchat' ? triggers.ytSuperchat !== false : triggers.cashTips !== false;
    const rawCur = String(tx.currency || baseCur).trim().toUpperCase();
    const grossBase = convertCrossCurrency(Number(tx.amount), rawCur, baseCur, rates);
    const creditMs = enabled ? creditForAmount(grossBase, cfg) : 0;
    return {
      grossAmount: grossBase,
      baseCurrency: baseCur,
      creditMs,
      timerEnabled: enabled,
      resolvedLabel: null,
      units: null,
    };
  }

  if (kind === 'yt_member' || kind === 'yt_gift_member') {
    const isGift = kind === 'yt_gift_member';
    const enabled = isGift ? triggers.ytGiftMember !== false : triggers.ytMember !== false;
    const qty = isGift ? Math.max(1, Math.trunc(Number(tx.quantity || 1))) : 1;
    const targetName = typeof tx.levelName === 'string' ? tx.levelName.trim().toLowerCase() : '';
    const lvl = ev.ytLevels.find((l) => l.name.toLowerCase() === targetName)
      || ev.ytLevels.find((l) => l.isDefault)
      || ev.ytLevels[0];
    const grossAmount = roundCurrency(qty * (lvl?.price || 0), baseCur);
    let creditMs = 0;
    if (enabled && lvl) {
      creditMs = lvl.creditMode === 'follow_tiers'
        ? creditForAmount(grossAmount, cfg)
        : Math.min(MAX_SAFE_MS, qty * lvl.fixedMs);
    }
    return {
      grossAmount,
      baseCurrency: baseCur,
      creditMs,
      timerEnabled: enabled,
      resolvedLabel: lvl ? lvl.name : 'Member',
      units: qty,
    };
  }

  if (kind === 'twitch_prime' || kind === 'twitch_sub' || kind === 'twitch_gift_sub') {
    const isGift = kind === 'twitch_gift_sub';
    const planKey = kind === 'twitch_prime' ? 'prime' : normalizeTwitchPlanKey(tx.tierKey);
    const isPrime = !isGift && planKey === 'prime';
    const enabled = isGift
      ? triggers.twitchGiftSub !== false
      : (isPrime ? triggers.twitchPrime !== false : triggers.twitchSub !== false);
    const qty = isGift ? Math.max(1, Math.trunc(Number(tx.quantity || 1))) : 1;
    const tier = ev.twitchTiers[planKey] || ev.twitchTiers['1000'];
    const grossAmount = roundCurrency(qty * tier.price, baseCur);
    let creditMs = 0;
    if (enabled) {
      creditMs = tier.creditMode === 'follow_tiers'
        ? creditForAmount(grossAmount, cfg)
        : Math.min(MAX_SAFE_MS, qty * tier.fixedMs);
    }
    return {
      grossAmount,
      baseCurrency: baseCur,
      creditMs,
      timerEnabled: enabled,
      resolvedLabel: tier.label,
      units: qty,
    };
  }

  if (kind === 'yt_jewels' || kind === 'twitch_bits') {
    const isJewels = kind === 'yt_jewels';
    const enabled = isJewels ? triggers.ytJewels !== false : triggers.twitchBits !== false;
    const units = Math.max(0, Math.trunc(Number(tx.units || 0)));
    const rate = isJewels ? ev.virtualRates.ytJewels : ev.virtualRates.twitchBits;
    const grossAmount = roundCurrency((units / Math.max(1, rate.perUnit)) * rate.pricePerUnit, baseCur);
    let creditMs = 0;
    if (enabled && units > 0) {
      creditMs = rate.creditMode === 'follow_tiers'
        ? creditForAmount(grossAmount, cfg)
        : Math.min(MAX_SAFE_MS, Math.floor(units / Math.max(1, rate.perUnit)) * rate.unitMs);
    }
    return {
      grossAmount,
      baseCurrency: baseCur,
      creditMs,
      timerEnabled: enabled,
      resolvedLabel: `${units} ${isJewels ? 'jewels' : 'bits'}`,
      units,
    };
  }

  return { grossAmount: 0, baseCurrency: baseCur, creditMs: 0, timerEnabled: false, resolvedLabel: null, units: null };
}
