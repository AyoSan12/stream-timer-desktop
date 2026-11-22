// Pure Dynamic-Currency Financial Accounting Engine & 5-Format Report Exporter.
//
// Operates natively in ANY profile `baseCurrency` (USD, IDR, JPY, KRW, EUR, GBP,
// SGD, MYR, TWD, BRL, etc.) using cent-safe integer-hundredth summation so
// decimal currencies ($0.10 + $0.20 = $0.30) never suffer float drift.
//
// Zero external dependencies: exports authentic 3-sheet .xlsx (Office Open XML),
// Excel-ready UTF-8 BOM .csv, structured .json, Markdown .md, and Apple-styled
// printable HTML/PDF Financial Statements.

import zlib from 'node:zlib';
import {
  BASELINE_RATES_PER_USD,
  convertCrossCurrency,
  currencyDecimals,
  roundCurrency,
} from './fx.js';

export const FINANCE_CHANNEL_ORDER = [
  'streamlabs',
  'streamelements',
  'kofi',
  'buymeacoffee',
  'tiltify',
  'tako',
  'saweria',
  'sociabuzz',
  'trakteer',
  'tipeeestream',
  'donationalerts',
  'chzzk',
  'ecpay',
  'doneru',
  'livepix',
  'yt_superchat',
  'yt_membership',
  'yt_jewels',
  'twitch_sub',
  'twitch_bits',
  'manual',
];

const CHANNEL_DEFS = {
  streamlabs:     { label: 'Streamlabs Tips',           platformFeePct: 0,    paymentFeePct: 2.9, fixedFeeUsd: 0.30 },
  streamelements: { label: 'StreamElements Tips',       platformFeePct: 0,    paymentFeePct: 2.9, fixedFeeUsd: 0.30 },
  kofi:           { label: 'Ko-fi',                     platformFeePct: 0,    paymentFeePct: 3.0, fixedFeeUsd: 0.30 },
  buymeacoffee:   { label: 'Buy Me a Coffee',           platformFeePct: 5,    paymentFeePct: 2.9, fixedFeeUsd: 0.30 },
  tiltify:        { label: 'Tiltify',                   platformFeePct: 5,    paymentFeePct: 2.9, fixedFeeUsd: 0.30 },
  tako:           { label: 'Tako.id',                   platformFeePct: 5,    paymentFeePct: 0,   fixedFeeUsd: 0 },
  saweria:        { label: 'Saweria',                   platformFeePct: 5,    paymentFeePct: 0,   fixedFeeUsd: 0 },
  sociabuzz:      { label: 'SociaBuzz',                 platformFeePct: 5,    paymentFeePct: 0,   fixedFeeUsd: 0 },
  trakteer:       { label: 'Trakteer',                  platformFeePct: 5,    paymentFeePct: 0,   fixedFeeUsd: 0 },
  tipeeestream:   { label: 'TipeeeStream',              platformFeePct: 0,    paymentFeePct: 3.4, fixedFeeUsd: 0.35 },
  donationalerts: { label: 'DonationAlerts',            platformFeePct: 7,    paymentFeePct: 0,   fixedFeeUsd: 0 },
  chzzk:          { label: 'Naver Chzzk (Cheese)',      platformFeePct: 20,   paymentFeePct: 0,   fixedFeeUsd: 0 },
  ecpay:          { label: 'ECPay (綠界)',              platformFeePct: 2.75, paymentFeePct: 0,   fixedFeeUsd: 0 },
  doneru:         { label: 'Doneru / OFUSE',            platformFeePct: 5,    paymentFeePct: 3.6, fixedFeeUsd: 0 },
  livepix:        { label: 'LivePix (PIX)',             platformFeePct: 5,    paymentFeePct: 0,   fixedFeeUsd: 0 },
  yt_superchat:   { label: 'YouTube Super Chat',        platformFeePct: 30,   paymentFeePct: 0,   fixedFeeUsd: 0 },
  yt_membership:  { label: 'YouTube Membership & Gift', platformFeePct: 30,   paymentFeePct: 0,   fixedFeeUsd: 0 },
  yt_jewels:      { label: 'YouTube Jewels / Gifts',    platformFeePct: 30,   paymentFeePct: 0,   fixedFeeUsd: 0 },
  twitch_sub:     { label: 'Twitch Sub / Prime / Gift', platformFeePct: 50,   paymentFeePct: 0,   fixedFeeUsd: 0 },
  twitch_bits:    { label: 'Twitch Bits',               platformFeePct: 0,    paymentFeePct: 0,   fixedFeeUsd: 0 },
  manual:         { label: 'Manual / Direct Transfer',  platformFeePct: 0,    paymentFeePct: 0,   fixedFeeUsd: 0 },
};

export function buildDefaultFinanceConfig(baseCurrency = 'USD', rates = BASELINE_RATES_PER_USD) {
  const cur = String(baseCurrency || 'USD').trim().toUpperCase();
  const channels = {};
  for (const key of FINANCE_CHANNEL_ORDER) {
    const d = CHANNEL_DEFS[key];
    channels[key] = {
      label: d.label,
      platformFeePct: d.platformFeePct,
      paymentFeePct: d.paymentFeePct,
      fixedFee: d.fixedFeeUsd > 0 ? convertCrossCurrency(d.fixedFeeUsd, 'USD', cur, rates) : 0,
    };
  }
  return {
    baseCurrency: cur,
    taxReservePct: 0,
    taxBasis: 'after_fees',
    channels,
  };
}

function clampPct(v, fb) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return fb;
  return Number(n.toFixed(2));
}

function clampFixed(v, cur, fb) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) return fb;
  return roundCurrency(n, cur);
}

export function sanitizeFinanceConfig(raw, baseCurrency = 'USD', rates = BASELINE_RATES_PER_USD) {
  const cur = String(raw?.baseCurrency || baseCurrency || 'USD').trim().toUpperCase();
  const def = buildDefaultFinanceConfig(cur, rates);
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const taxReservePct = clampPct(src.taxReservePct ?? def.taxReservePct, 0);
  const taxBasis = src.taxBasis === 'gross' ? 'gross' : 'after_fees';
  const rawChannels = src.channels && typeof src.channels === 'object' ? src.channels : {};
  const channels = {};
  for (const key of FINANCE_CHANNEL_ORDER) {
    const d = def.channels[key];
    const item = rawChannels[key] && typeof rawChannels[key] === 'object' ? rawChannels[key] : {};
    channels[key] = {
      label: d.label,
      platformFeePct: clampPct(item.platformFeePct ?? d.platformFeePct, d.platformFeePct),
      paymentFeePct: clampPct(item.paymentFeePct ?? d.paymentFeePct, d.paymentFeePct),
      fixedFee: clampFixed(item.fixedFee ?? item.fixedFeeIdr ?? d.fixedFee, cur, d.fixedFee),
    };
  }
  return { baseCurrency: cur, taxReservePct, taxBasis, channels };
}

export function resolveFinanceChannelKey(provider, txType = '') {
  const p = String(provider || '').trim().toLowerCase();
  const t = String(txType || '').trim().toLowerCase();
  if (p === 'streamlabs') return 'streamlabs';
  if (p === 'streamelements') return 'streamelements';
  if (p === 'kofi' || p === 'ko-fi') return 'kofi';
  if (p === 'buymeacoffee' || p === 'bmc') return 'buymeacoffee';
  if (p === 'tiltify') return 'tiltify';
  if (p === 'tako' || p === 'tako.id') return 'tako';
  if (p === 'saweria') return 'saweria';
  if (p === 'sociabuzz' || p === 'socialbuzz') return 'sociabuzz';
  if (p === 'trakteer') return 'trakteer';
  if (p === 'tipeeestream') return 'tipeeestream';
  if (p === 'donationalerts') return 'donationalerts';
  if (p === 'chzzk') return 'chzzk';
  if (p === 'ecpay') return 'ecpay';
  if (p === 'doneru' || p === 'ofuse') return 'doneru';
  if (p === 'livepix') return 'livepix';
  if (p === 'superchat' || p === 'yt-superchat' || p === 'yt-supersticker' || t === 'yt_superchat') return 'yt_superchat';
  if (p === 'yt_member' || p === 'yt-membership' || p === 'yt_gift_member' || p === 'yt-gift-member' || t === 'yt_member' || t === 'yt_gift_member') return 'yt_membership';
  if (p === 'yt_jewels' || p === 'yt-jewels' || t === 'yt_jewels') return 'yt_jewels';
  if (p === 'twitch_sub' || p === 'twitch-sub' || p === 'twitch_prime' || p === 'twitch-prime' || p === 'twitch_gift_sub' || p === 'twitch-gift-sub' || t === 'twitch_sub' || t === 'twitch_prime' || t === 'twitch_gift_sub') return 'twitch_sub';
  if (p === 'twitch_bits' || p === 'twitch-bits' || t === 'twitch_bits') return 'twitch_bits';
  return 'manual';
}

export function formatMoney(amount, currency = 'USD', locale = 'en-US') {
  const cur = String(currency || 'USD').trim().toUpperCase();
  const dec = currencyDecimals(cur);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    }).format(Number(amount) || 0).replace(/\u00a0/g, ' ');
  } catch {
    return `${cur} ${roundCurrency(amount, cur).toFixed(dec)}`;
  }
}

const toCents = (n) => Math.round((Number(n) || 0) * 100);
const fromCents = (c, cur) => roundCurrency(c / 100, cur);

/**
 * Pure cent-safe Gross -> Deductions -> Net breakdown in `config.baseCurrency`.
 */
export function calculateFinanceBreakdown(grossAmount, channelKey, rawConfig) {
  const cfg = sanitizeFinanceConfig(rawConfig, rawConfig?.baseCurrency || 'USD');
  const cur = cfg.baseCurrency;
  const key = Object.prototype.hasOwnProperty.call(cfg.channels, channelKey) ? channelKey : 'manual';
  const rule = cfg.channels[key];

  const gross = Math.max(0, roundCurrency(grossAmount, cur));
  const platformFee = roundCurrency(gross * (rule.platformFeePct / 100), cur);
  const paymentFee = roundCurrency(gross * (rule.paymentFeePct / 100), cur);
  const fixedFee = gross > 0 ? Math.min(gross, Math.max(0, roundCurrency(rule.fixedFee, cur))) : 0;

  const grossC = toCents(gross);
  const preTaxC = Math.min(grossC, toCents(platformFee) + toCents(paymentFee) + toCents(fixedFee));
  const afterFeeC = Math.max(0, grossC - preTaxC);

  const taxBase = cfg.taxBasis === 'gross' ? gross : fromCents(afterFeeC, cur);
  const taxReserve = roundCurrency(taxBase * (cfg.taxReservePct / 100), cur);

  const totalDedC = Math.min(grossC, preTaxC + toCents(taxReserve));
  const netC = Math.max(0, grossC - totalDedC);

  const totalDeductions = fromCents(totalDedC, cur);
  const netAmount = fromCents(netC, cur);
  const effectiveFeePct = grossC > 0 ? Number(((totalDedC / grossC) * 100).toFixed(2)) : 0;

  const parts = [formatMoney(gross, cur)];
  if (platformFee > 0) parts.push(`- ${rule.platformFeePct}% Platform (${formatMoney(platformFee, cur)})`);
  if (paymentFee > 0) parts.push(`- ${rule.paymentFeePct}% Payment (${formatMoney(paymentFee, cur)})`);
  if (fixedFee > 0) parts.push(`- Fixed (${formatMoney(fixedFee, cur)})`);
  if (taxReserve > 0) parts.push(`- ${cfg.taxReservePct}% Tax (${formatMoney(taxReserve, cur)})`);
  const formulaText = `${parts.join(' ')} = Net ${formatMoney(netAmount, cur)}`;

  return {
    baseCurrency: cur,
    channelKey: key,
    channelLabel: rule.label,
    grossAmount: gross,
    platformFeePct: rule.platformFeePct,
    platformFee,
    paymentFeePct: rule.paymentFeePct,
    paymentFee,
    fixedFee,
    taxReservePct: cfg.taxReservePct,
    taxBasis: cfg.taxBasis,
    taxReserve,
    totalDeductions,
    netAmount,
    effectiveFeePct,
    formulaText,
  };
}

export function resolveRowFinance(row, financeConfig) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const channelKey = resolveFinanceChannelKey(row.provider, payload.txType);
  const cur = financeConfig.baseCurrency || 'USD';
  const gross = Math.max(0, roundCurrency(row.grossAmount, cur));
  const snap = payload.finance;
  if (
    snap && typeof snap === 'object'
    && snap.baseCurrency === cur
    && Number.isFinite(Number(snap.grossAmount))
    && toCents(snap.grossAmount) === toCents(gross)
    && Number.isFinite(Number(snap.netAmount))
  ) {
    return {
      ...snap,
      channelKey: snap.channelKey || channelKey,
      channelLabel: snap.channelLabel || CHANNEL_DEFS[channelKey]?.label || 'Manual',
      snapshotted: true,
    };
  }
  return { ...calculateFinanceBreakdown(gross, channelKey, financeConfig), snapshotted: false };
}

function findSessionForTimestamp(tsMs, sessionsAsc) {
  for (let i = sessionsAsc.length - 1; i >= 0; i -= 1) {
    const s = sessionsAsc[i];
    if (tsMs >= s.startedAtMs && (s.endedAtMs === null || tsMs < s.endedAtMs)) return s;
  }
  return sessionsAsc[0] || { sessionId: 'session-1', seqNum: 1, label: 'Session #1', startedAtMs: 0, endedAtMs: null };
}

export function buildFinanceReport(rawRows, rawSessions, rawConfig, filters = {}) {
  const config = sanitizeFinanceConfig(rawConfig, rawConfig?.baseCurrency || 'USD');
  const cur = config.baseCurrency;

  const sessionsAsc = (Array.isArray(rawSessions) && rawSessions.length > 0
    ? rawSessions
    : [{ sessionId: 'session-1', seqNum: 1, label: 'Session #1', notes: '', startedAtMs: 0, endedAtMs: null, createdAtMs: 0 }]
  ).map((s) => ({
    sessionId: s.sessionId,
    seqNum: Number(s.seqNum) || 1,
    label: s.label || `Session #${s.seqNum || 1}`,
    notes: s.notes || '',
    startedAtMs: Number(s.startedAtMs) || 0,
    endedAtMs: s.endedAtMs === null || s.endedAtMs === undefined ? null : Number(s.endedAtMs),
    createdAtMs: Number(s.createdAtMs) || 0,
  })).sort((a, b) => a.startedAtMs - b.startedAtMs || a.seqNum - b.seqNum);

  const activeSession = sessionsAsc.find((s) => s.endedAtMs === null) || sessionsAsc[sessionsAsc.length - 1];
  const includeDeleted = filters.includeDeleted === true || filters.includeDeleted === 'true' || filters.includeDeleted === '1';

  const sessMap = new Map();
  for (const s of sessionsAsc) {
    sessMap.set(s.sessionId, {
      ...s,
      isActive: s.endedAtMs === null,
      txCount: 0,
      grossC: 0,
      deductC: 0,
      netC: 0,
      totalCreditMs: 0,
    });
  }

  const enrichedAll = [];
  for (const row of rawRows) {
    const isDeleted = row.deletedAtMs !== null && row.deletedAtMs !== undefined;
    if (isDeleted && !includeDeleted) continue;

    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const appliedAtMs = Number(row.appliedAtMs) || 0;
    const sess = findSessionForTimestamp(appliedAtMs, sessionsAsc);
    const fin = resolveRowFinance({ ...row, payload }, config);

    const origCurrency = typeof payload.originalCurrency === 'string' && payload.originalCurrency.trim()
      ? payload.originalCurrency.trim().toUpperCase()
      : String(row.currency || cur).toUpperCase();
    const origAmount = Number.isFinite(Number(payload.originalAmount)) && Number(payload.originalAmount) > 0
      ? Number(payload.originalAmount)
      : fin.grossAmount;

    const item = {
      eventId: row.eventId,
      sessionId: sess.sessionId,
      sessionLabel: sess.label,
      appliedAtMs,
      provider: row.provider,
      txType: typeof payload.txType === 'string' ? payload.txType : fin.channelKey,
      channelKey: fin.channelKey,
      channelLabel: fin.channelLabel,
      gifterName: typeof payload.gifterName === 'string' && payload.gifterName.trim() ? payload.gifterName.trim() : 'Anonymous',
      message: typeof payload.message === 'string' ? payload.message : '',
      tierOrLevel: typeof payload.tierOrLevel === 'string' ? payload.tierOrLevel : null,
      units: typeof payload.units === 'number' ? payload.units : null,
      originalAmount: origAmount,
      originalCurrency: origCurrency,
      baseCurrency: cur,
      grossAmount: fin.grossAmount,
      platformFeePct: fin.platformFeePct,
      platformFee: fin.platformFee,
      paymentFeePct: fin.paymentFeePct,
      paymentFee: fin.paymentFee,
      fixedFee: fin.fixedFee,
      taxReservePct: fin.taxReservePct,
      taxBasis: fin.taxBasis,
      taxReserve: fin.taxReserve,
      totalDeductions: fin.totalDeductions,
      netAmount: fin.netAmount,
      effectiveFeePct: fin.effectiveFeePct,
      formulaText: fin.formulaText,
      creditMs: Number(row.creditMs) || 0,
      deleted: isDeleted,
      snapshotted: fin.snapshotted,
    };
    enrichedAll.push(item);

    const st = sessMap.get(sess.sessionId);
    if (st) {
      st.txCount += 1;
      st.grossC += toCents(item.grossAmount);
      st.deductC += toCents(item.totalDeductions);
      st.netC += toCents(item.netAmount);
      st.totalCreditMs += item.creditMs;
    }
  }

  const sessionsDesc = [...sessMap.values()].map((st) => ({
    sessionId: st.sessionId,
    seqNum: st.seqNum,
    label: st.label,
    notes: st.notes,
    startedAtMs: st.startedAtMs,
    endedAtMs: st.endedAtMs,
    createdAtMs: st.createdAtMs,
    isActive: st.isActive,
    txCount: st.txCount,
    grossAmount: fromCents(st.grossC, cur),
    totalDeductions: fromCents(st.deductC, cur),
    netAmount: fromCents(st.netC, cur),
    effectiveFeePct: st.grossC > 0 ? Number(((st.deductC / st.grossC) * 100).toFixed(2)) : 0,
    totalCreditMs: st.totalCreditMs,
  })).sort((a, b) => b.seqNum - a.seqNum);

  const sessionById = Object.fromEntries(sessionsDesc.map((s) => [s.sessionId, s]));
  const rawScope = typeof filters.session === 'string' && filters.session.trim() ? filters.session.trim() : 'current';
  let scopeSession = null;
  let scopeId = 'all';
  let scopeLabel = 'All-Time';
  if (rawScope === 'current') {
    scopeSession = sessionById[activeSession.sessionId];
    scopeId = activeSession.sessionId;
    scopeLabel = activeSession.label;
  } else if (rawScope !== 'all' && sessionById[rawScope]) {
    scopeSession = sessionById[rawScope];
    scopeId = scopeSession.sessionId;
    scopeLabel = scopeSession.label;
  }

  const q = typeof filters.q === 'string' ? filters.q.trim().toLowerCase() : '';
  const channelFilter = typeof filters.channel === 'string' && filters.channel && filters.channel !== 'all' ? filters.channel.toLowerCase() : null;
  const currencyFilter = typeof filters.currency === 'string' && filters.currency && filters.currency !== 'all' ? filters.currency.toUpperCase() : null;
  const fromMs = Number.isFinite(Number(filters.fromMs)) && Number(filters.fromMs) > 0 ? Number(filters.fromMs) : null;
  const toMs = Number.isFinite(Number(filters.toMs)) && Number(filters.toMs) > 0 ? Number(filters.toMs) : null;
  const minGross = Number.isFinite(Number(filters.minGross)) && Number(filters.minGross) > 0 ? Number(filters.minGross) : null;

  const matched = enrichedAll.filter((tx) => {
    if (scopeSession && tx.sessionId !== scopeSession.sessionId) return false;
    if (channelFilter && tx.channelKey !== channelFilter) return false;
    if (currencyFilter === 'FOREIGN' && tx.originalCurrency === cur) return false;
    if (currencyFilter === 'LOCAL' && tx.originalCurrency !== cur) return false;
    if (currencyFilter && currencyFilter !== 'FOREIGN' && currencyFilter !== 'LOCAL' && tx.originalCurrency !== currencyFilter) return false;
    if (fromMs !== null && tx.appliedAtMs < fromMs) return false;
    if (toMs !== null && tx.appliedAtMs > toMs) return false;
    if (minGross !== null && tx.grossAmount < minGross) return false;
    if (q) {
      const hay = [
        tx.gifterName, tx.eventId, tx.provider, tx.channelLabel, tx.channelKey,
        tx.message, tx.tierOrLevel || '', tx.originalCurrency, tx.sessionLabel,
        String(tx.grossAmount), String(tx.netAmount),
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sort = typeof filters.sort === 'string' ? filters.sort : 'latest';
  if (sort === 'oldest') matched.sort((a, b) => a.appliedAtMs - b.appliedAtMs);
  else if (sort === 'gross_desc') matched.sort((a, b) => b.grossAmount - a.grossAmount || b.appliedAtMs - a.appliedAtMs);
  else if (sort === 'net_desc') matched.sort((a, b) => b.netAmount - a.netAmount || b.appliedAtMs - a.appliedAtMs);
  else if (sort === 'fee_desc') matched.sort((a, b) => b.totalDeductions - a.totalDeductions || b.appliedAtMs - a.appliedAtMs);
  else matched.sort((a, b) => b.appliedAtMs - a.appliedAtMs || b.eventId.localeCompare(a.eventId));

  let grossC = 0; let platC = 0; let payC = 0; let fixC = 0; let taxC = 0; let dedC = 0; let netC = 0; let creditMs = 0;
  const chanMap = new Map();
  const curMap = new Map();

  for (const tx of matched) {
    grossC += toCents(tx.grossAmount);
    platC += toCents(tx.platformFee);
    payC += toCents(tx.paymentFee);
    fixC += toCents(tx.fixedFee);
    taxC += toCents(tx.taxReserve);
    dedC += toCents(tx.totalDeductions);
    netC += toCents(tx.netAmount);
    creditMs += tx.creditMs;

    if (!chanMap.has(tx.channelKey)) {
      const rule = config.channels[tx.channelKey] || config.channels.manual;
      chanMap.set(tx.channelKey, {
        channelKey: tx.channelKey,
        channelLabel: tx.channelLabel,
        platformFeePct: rule.platformFeePct,
        paymentFeePct: rule.paymentFeePct,
        fixedFee: rule.fixedFee,
        txCount: 0,
        grossC: 0,
        deductC: 0,
        netC: 0,
      });
    }
    const ch = chanMap.get(tx.channelKey);
    ch.txCount += 1;
    ch.grossC += toCents(tx.grossAmount);
    ch.deductC += toCents(tx.totalDeductions);
    ch.netC += toCents(tx.netAmount);

    if (!curMap.has(tx.originalCurrency)) {
      curMap.set(tx.originalCurrency, { currency: tx.originalCurrency, txCount: 0, originalTotal: 0, grossC: 0, netC: 0 });
    }
    const cr = curMap.get(tx.originalCurrency);
    cr.txCount += 1;
    cr.originalTotal = Number((cr.originalTotal + tx.originalAmount).toFixed(4));
    cr.grossC += toCents(tx.grossAmount);
    cr.netC += toCents(tx.netAmount);
  }

  const txCount = matched.length;
  const summary = {
    baseCurrency: cur,
    txCount,
    grossAmount: fromCents(grossC, cur),
    platformFee: fromCents(platC, cur),
    paymentFee: fromCents(payC, cur),
    fixedFee: fromCents(fixC, cur),
    taxReserve: fromCents(taxC, cur),
    totalDeductions: fromCents(dedC, cur),
    netAmount: fromCents(netC, cur),
    effectiveFeePct: grossC > 0 ? Number(((dedC / grossC) * 100).toFixed(2)) : 0,
    takeHomePct: grossC > 0 ? Number(((netC / grossC) * 100).toFixed(2)) : 100,
    avgGross: txCount > 0 ? fromCents(Math.round(grossC / txCount), cur) : 0,
    avgNet: txCount > 0 ? fromCents(Math.round(netC / txCount), cur) : 0,
    totalCreditMs: creditMs,
  };

  const byChannel = [...chanMap.values()].map((ch) => ({
    channelKey: ch.channelKey,
    channelLabel: ch.channelLabel,
    platformFeePct: ch.platformFeePct,
    paymentFeePct: ch.paymentFeePct,
    fixedFee: ch.fixedFee,
    txCount: ch.txCount,
    grossAmount: fromCents(ch.grossC, cur),
    totalDeductions: fromCents(ch.deductC, cur),
    netAmount: fromCents(ch.netC, cur),
    effectiveFeePct: ch.grossC > 0 ? Number(((ch.deductC / ch.grossC) * 100).toFixed(2)) : 0,
    shareOfGrossPct: grossC > 0 ? Number(((ch.grossC / grossC) * 100).toFixed(1)) : 0,
    shareOfNetPct: netC > 0 ? Number(((ch.netC / netC) * 100).toFixed(1)) : 0,
  })).sort((a, b) => b.grossAmount - a.grossAmount);

  const byCurrency = [...curMap.values()].map((cr) => ({
    currency: cr.currency,
    txCount: cr.txCount,
    originalTotal: cr.originalTotal,
    grossAmount: fromCents(cr.grossC, cur),
    netAmount: fromCents(cr.netC, cur),
  })).sort((a, b) => b.grossAmount - a.grossAmount);

  const limit = Number.isFinite(Number(filters.limit)) && Number(filters.limit) > 0
    ? Math.min(10_000, Math.trunc(Number(filters.limit)))
    : 500;

  return {
    exportedAtIso: new Date().toISOString(),
    baseCurrency: cur,
    scope: {
      requested: rawScope,
      sessionId: scopeId,
      label: scopeLabel,
      startedAtMs: scopeSession ? scopeSession.startedAtMs : 0,
      endedAtMs: scopeSession ? scopeSession.endedAtMs : null,
      isActive: scopeSession ? scopeSession.isActive : false,
    },
    filters: { q, channel: channelFilter || 'all', currency: currencyFilter || 'all', fromMs, toMs, minGross, sort, includeDeleted },
    activeSession: sessionById[activeSession.sessionId],
    sessions: sessionsDesc,
    summary,
    byChannel,
    byCurrency,
    totalMatched: txCount,
    transactions: matched.slice(0, limit),
    config,
  };
}

// --------------------------------------------------- 5-Format Exporters -----

function csvCell(val) {
  const s = val === null || val === undefined ? '' : String(val);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportFinanceCsv(report) {
  const cur = report.baseCurrency;
  const headers = [
    'Timestamp (ISO)', 'Date', 'Time', 'Session', 'Event ID', 'Donor', 'Platform', 'Raw Source',
    'Tier / Level', 'Qty / Units', 'Original Amount', 'Original Currency',
    `Gross (${cur})`, 'Platform Fee (%)', `Platform Fee (${cur})`, 'Payment Fee (%)', `Payment Fee (${cur})`,
    `Fixed Fee (${cur})`, 'Tax Reserve (%)', `Tax Reserve (${cur})`, `Total Deductions (${cur})`,
    'Effective Cut (%)', `Net Revenue (${cur})`, 'Timer Credit (sec)', 'Formula', 'Message',
  ];
  const lines = [headers.map(csvCell).join(',')];
  for (const tx of report.transactions) {
    const iso = new Date(tx.appliedAtMs).toISOString();
    lines.push([
      iso, iso.slice(0, 10), iso.slice(11, 19), tx.sessionLabel, tx.eventId, tx.gifterName,
      tx.channelLabel, tx.provider, tx.tierOrLevel || '', tx.units ?? '',
      tx.originalAmount, tx.originalCurrency, tx.grossAmount, tx.platformFeePct, tx.platformFee,
      tx.paymentFeePct, tx.paymentFee, tx.fixedFee, tx.taxReservePct, tx.taxReserve,
      tx.totalDeductions, tx.effectiveFeePct, tx.netAmount, Math.round((tx.creditMs || 0) / 1000),
      tx.formulaText, tx.message,
    ].map(csvCell).join(','));
  }
  const s = report.summary;
  lines.push([
    'TOTAL', '', '', report.scope.label, `${s.txCount} transactions`, '', '', '', '', '', '', cur,
    s.grossAmount, '', s.platformFee, '', s.paymentFee, s.fixedFee, '', s.taxReserve,
    s.totalDeductions, s.effectiveFeePct, s.netAmount, Math.round((s.totalCreditMs || 0) / 1000), '', '',
  ].map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function exportFinanceJson(report) {
  return JSON.stringify(report, null, 2);
}

export function exportFinanceMarkdown(report) {
  const cur = report.baseCurrency;
  const s = report.summary;
  const fmt = (v) => formatMoney(v, cur);
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [
    `# Stream Revenue Report — ${report.scope.label}`,
    '',
    `- **Currency:** ${cur}`,
    `- **Generated:** ${report.exportedAtIso}`,
    `- **Transactions:** ${s.txCount}`,
    `- **Gross Revenue:** ${fmt(s.grossAmount)}`,
    `- **Total Deductions:** -${fmt(s.totalDeductions)} (${s.effectiveFeePct}%)`,
    `- **Net Take-Home:** **${fmt(s.netAmount)}** (${s.takeHomePct}%)`,
    '',
    '## Platform Breakdown',
    '',
    `| Platform | Tx | Gross (${cur}) | Deductions | Effective Cut | Net (${cur}) | Share |`,
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const ch of report.byChannel) {
    lines.push(`| ${esc(ch.channelLabel)} | ${ch.txCount} | ${fmt(ch.grossAmount)} | -${fmt(ch.totalDeductions)} | ${ch.effectiveFeePct}% | ${fmt(ch.netAmount)} | ${ch.shareOfNetPct}% |`);
  }
  lines.push(
    '',
    '## Itemized Transactions',
    '',
    `| Date/Time (UTC) | Session | Donor | Platform | Original | Gross (${cur}) | Deductions | Net (${cur}) | Event ID |`,
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
  );
  for (const tx of report.transactions) {
    const dt = new Date(tx.appliedAtMs).toISOString().replace('T', ' ').slice(0, 19);
    const orig = tx.originalCurrency !== cur ? `${tx.originalAmount} ${tx.originalCurrency}` : '-';
    lines.push(`| ${dt} | ${esc(tx.sessionLabel)} | ${esc(tx.gifterName)} | ${esc(tx.channelLabel)} | ${orig} | ${fmt(tx.grossAmount)} | -${fmt(tx.totalDeductions)} (${tx.effectiveFeePct}%) | ${fmt(tx.netAmount)} | \`${esc(tx.eventId)}\` |`);
  }
  return `${lines.join('\n')}\n`;
}

function escHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function exportFinanceHtmlReport(report) {
  const cur = report.baseCurrency;
  const s = report.summary;
  const fmt = (v) => formatMoney(v, cur);
  const chanRows = report.byChannel.map((ch) => `
    <tr>
      <td><strong>${escHtml(ch.channelLabel)}</strong><div class="sub">${ch.platformFeePct}% platform${ch.paymentFeePct ? ` · ${ch.paymentFeePct}% pay` : ''}${ch.fixedFee ? ` · +${escHtml(fmt(ch.fixedFee))}` : ''}</div></td>
      <td class="num">${ch.txCount}</td>
      <td class="num">${escHtml(fmt(ch.grossAmount))}</td>
      <td class="num neg">-${escHtml(fmt(ch.totalDeductions))} <span class="sub">(${ch.effectiveFeePct}%)</span></td>
      <td class="num"><strong>${escHtml(fmt(ch.netAmount))}</strong></td>
      <td class="num">${ch.shareOfNetPct}%</td>
    </tr>`).join('');

  const txRows = report.transactions.map((tx) => {
    const dt = new Date(tx.appliedAtMs).toISOString().replace('T', ' ').slice(0, 19);
    const orig = tx.originalCurrency !== cur ? `<div class="sub">${escHtml(tx.originalAmount)} ${escHtml(tx.originalCurrency)}</div>` : '';
    return `
    <tr>
      <td class="mono">${escHtml(dt)}</td>
      <td><strong>${escHtml(tx.gifterName)}</strong><div class="sub mono">${escHtml(tx.eventId)}</div></td>
      <td>${escHtml(tx.channelLabel)}${tx.tierOrLevel ? `<div class="sub">${escHtml(tx.tierOrLevel)}</div>` : ''}</td>
      <td class="num">${escHtml(fmt(tx.grossAmount))}${orig}</td>
      <td class="num neg">-${escHtml(fmt(tx.totalDeductions))}<div class="sub">${tx.effectiveFeePct}%</div></td>
      <td class="num"><strong>${escHtml(fmt(tx.netAmount))}</strong></td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Financial Statement — ${escHtml(report.scope.label)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #f5f5f7; color: #1d1d1f; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; font-size: 13px; }
  .sheet { max-width: 980px; margin: 0 auto; background: #fff; border-radius: 18px; padding: 32px 36px; border: 1px solid #d2d2d7; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #e5e5ea; padding-bottom: 18px; margin-bottom: 22px; }
  h1 { margin: 0 0 4px; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  h2 { margin: 26px 0 10px; font-size: 16px; font-weight: 600; }
  .muted, .sub { color: #6e6e73; } .sub { font-size: 11px; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-variant-numeric: tabular-nums; }
  .print-btn { background: #0071e3; color: #fff; border: 0; border-radius: 999px; padding: 9px 18px; font-size: 13px; font-weight: 500; cursor: pointer; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .kpi { border: 1px solid #e5e5ea; border-radius: 14px; padding: 14px 16px; background: #fafafa; }
  .kpi.dark { background: #000; color: #fff; border-color: #000; }
  .kpi.dark .kpi-lbl, .kpi.dark .sub { color: #a1a1a6; }
  .kpi-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6e6e73; font-weight: 600; }
  .kpi-val { font-size: 20px; font-weight: 600; margin: 4px 0 2px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6e6e73; border-bottom: 1px solid #d2d2d7; padding: 8px 6px; }
  td { padding: 9px 6px; border-bottom: 1px solid #ececf0; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .neg { color: #b91c1c; }
  @media print { body { background: #fff; padding: 0; } .sheet { border: 0; border-radius: 0; padding: 0; max-width: none; } .print-btn { display: none; } }
</style></head><body><div class="sheet">
  <div class="head"><div><h1>Stream Financial Statement</h1><div class="muted">Scope: <strong>${escHtml(report.scope.label)}</strong> &middot; Currency: <strong>${escHtml(cur)}</strong> &middot; ${s.txCount} tx</div></div>
  <button class="print-btn" type="button" onclick="window.print()">Print / Save PDF</button></div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-lbl">Gross Revenue</div><div class="kpi-val">${escHtml(fmt(s.grossAmount))}</div><div class="sub">${s.txCount} tx</div></div>
    <div class="kpi"><div class="kpi-lbl">Total Deductions</div><div class="kpi-val neg">-${escHtml(fmt(s.totalDeductions))}</div><div class="sub">${s.effectiveFeePct}% effective cut</div></div>
    <div class="kpi dark"><div class="kpi-lbl">Net Take-Home</div><div class="kpi-val">${escHtml(fmt(s.netAmount))}</div><div class="sub">${s.takeHomePct}% kept</div></div>
    <div class="kpi"><div class="kpi-lbl">Avg Net / Tx</div><div class="kpi-val">${escHtml(fmt(s.avgNet))}</div><div class="sub">Avg Gross ${escHtml(fmt(s.avgGross))}</div></div>
  </div>
  <h2>Platform &amp; Deduction Breakdown</h2>
  <table><thead><tr><th>Platform</th><th class="num">Tx</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net</th><th class="num">Share</th></tr></thead><tbody>${chanRows || '<tr><td colspan="6" class="muted">No transactions.</td></tr>'}</tbody></table>
  <h2>Itemized Transaction Ledger (${report.transactions.length})</h2>
  <table><thead><tr><th>Date/Time (UTC)</th><th>Donor &amp; Event ID</th><th>Platform</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net</th></tr></thead><tbody>${txRows || '<tr><td colspan="6" class="muted">No transactions.</td></tr>'}</tbody></table>
</div></body></html>`;
}

// ----------------------------------------- Authentic 3-Sheet .xlsx Builder --

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compBuf.length, 18);
    local.writeUInt32LE(rawBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    localParts.push(local, compBuf);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compBuf.length, 20);
    central.writeUInt32LE(rawBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compBuf.length;
  }
  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function xmlEsc(v) {
  return String(v ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function colLetter(idx) {
  let n = idx + 1; let out = '';
  while (n > 0) { const rem = (n - 1) % 26; out = String.fromCharCode(65 + rem) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

function buildWorksheetXml(rows, widths = []) {
  const colsXml = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const rowXmls = rows.map((row, rIdx) => {
    const rNum = rIdx + 1;
    const cells = row.map((cell, cIdx) => {
      const ref = `${colLetter(cIdx)}${rNum}`;
      const isObj = cell !== null && typeof cell === 'object';
      const val = isObj ? cell.v : cell;
      const st = isObj && cell.s !== undefined ? ` s="${cell.s}"` : '';
      if (val === null || val === undefined || val === '') return '';
      if (typeof val === 'number' && Number.isFinite(val)) return `<c r="${ref}"${st}><v>${val}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${st}><is><t>${xmlEsc(val)}</t></is></c>`;
    }).filter(Boolean).join('');
    return `<row r="${rNum}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${rowXmls}</sheetData></worksheet>`;
}

export function exportFinanceXlsx(report) {
  const cur = report.baseCurrency;
  const dec = currencyDecimals(cur);
  const numFmtCode = dec === 0 ? '#,##0' : '#,##0.00';
  const s = report.summary;
  const h = (v) => ({ v, s: 1 });
  const num = (v) => ({ v: Number(v) || 0, s: 2 });
  const numBold = (v) => ({ v: Number(v) || 0, s: 3 });
  const pct = (v) => ({ v: Number(v) || 0, s: 4 });

  const summaryRows = [
    [h('Stream Financial Summary'), h(`Value (${cur})`)],
    ['Report Scope', report.scope.label],
    ['Base Currency', cur],
    ['Generated At (UTC)', report.exportedAtIso],
    ['Transaction Count', num(s.txCount)],
    [`Gross Revenue (${cur})`, numBold(s.grossAmount)],
    [`Platform Cuts (${cur})`, num(s.platformFee)],
    [`Payment Fees (${cur})`, num(s.paymentFee)],
    [`Fixed Gateway Fees (${cur})`, num(s.fixedFee)],
    [`Tax Reserve (${cur})`, num(s.taxReserve)],
    [`Total Deductions (${cur})`, numBold(s.totalDeductions)],
    ['Effective Deduction Rate (%)', pct(s.effectiveFeePct)],
    [`Net Take-Home (${cur})`, numBold(s.netAmount)],
    ['Take-Home Share (%)', pct(s.takeHomePct)],
  ];

  const platformRows = [
    [h('Platform'), h('Tx'), h('Platform %'), h('Payment %'), h(`Fixed (${cur})`), h(`Gross (${cur})`), h(`Deductions (${cur})`), h('Effective %'), h(`Net (${cur})`), h('Share %')],
    ...report.byChannel.map((ch) => [ch.channelLabel, num(ch.txCount), pct(ch.platformFeePct), pct(ch.paymentFeePct), num(ch.fixedFee), num(ch.grossAmount), num(ch.totalDeductions), pct(ch.effectiveFeePct), numBold(ch.netAmount), pct(ch.shareOfNetPct)]),
  ];

  const txRows = [
    [h('Timestamp (UTC)'), h('Session'), h('Event ID'), h('Donor'), h('Platform'), h('Tier/Level'), h('Orig Amount'), h('Orig Cur'), h(`Gross (${cur})`), h(`Platform Fee`), h(`Payment Fee`), h(`Fixed Fee`), h(`Tax`), h(`Total Deductions`), h('Cut %'), h(`Net (${cur})`), h('Credit (sec)'), h('Formula'), h('Message')],
    ...report.transactions.map((tx) => [
      new Date(tx.appliedAtMs).toISOString().replace('T', ' ').slice(0, 19), tx.sessionLabel, tx.eventId, tx.gifterName, tx.channelLabel, tx.tierOrLevel || '',
      tx.originalAmount, tx.originalCurrency, num(tx.grossAmount), num(tx.platformFee), num(tx.paymentFee), num(tx.fixedFee), num(tx.taxReserve),
      num(tx.totalDeductions), pct(tx.effectiveFeePct), numBold(tx.netAmount), num(Math.round((tx.creditMs || 0) / 1000)), tx.formulaText, tx.message,
    ]),
  ];

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="${numFmtCode}"/><numFmt numFmtId="165" formatCode="0.00&quot;%&quot;"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Platform Breakdown" sheetId="2" r:id="rId2"/><sheet name="Transactions" sheetId="3" r:id="rId3"/></sheets></workbook>`;
  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  return buildZipBuffer([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: rootRelsXml },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { name: 'xl/styles.xml', content: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', content: buildWorksheetXml(summaryRows, [32, 26]) },
    { name: 'xl/worksheets/sheet2.xml', content: buildWorksheetXml(platformRows, [28, 8, 12, 12, 14, 16, 16, 12, 16, 12]) },
    { name: 'xl/worksheets/sheet3.xml', content: buildWorksheetXml(txRows, [22, 16, 26, 20, 24, 16, 14, 10, 14, 14, 14, 12, 12, 16, 10, 14, 12, 42, 30]) },
  ]);
}
