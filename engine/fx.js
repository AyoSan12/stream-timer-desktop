// Live 166-currency exchange rate engine & background auto-updater.
//
// Primary:  https://open.er-api.com/v6/latest/USD (166 ISO-4217 currencies, free, no API key)
// Fallback: https://api.frankfurter.dev/v1/latest?base=USD (ECB reference rates)
//
// Stores USD-based rates (`ratesPerUsd`, where USD = 1.0) durably in local SQLite
// so ANY donor currency converts to ANY profile baseCurrency in O(1) locally
// with zero external latency or drift risk during live stream mutations.

const PRIMARY_URL = 'https://open.er-api.com/v6/latest/USD';
const FALLBACK_URL = 'https://api.frankfurter.dev/v1/latest?base=USD';
const ISO_CODE_RE = /^[A-Z]{3}$/;

// Realistic offline baseline (1 USD = X currency) used before the first live sync.
export const BASELINE_RATES_PER_USD = {
  USD: 1,
  IDR: 16200,
  JPY: 155,
  KRW: 1380,
  TWD: 32.5,
  CNY: 7.25,
  HKD: 7.78,
  SGD: 1.34,
  MYR: 4.45,
  PHP: 58.5,
  THB: 34.5,
  VND: 25400,
  EUR: 0.92,
  GBP: 0.79,
  AUD: 1.53,
  CAD: 1.39,
  NZD: 1.68,
  CHF: 0.88,
  BRL: 5.75,
  MXN: 20.1,
  INR: 84.5,
  SAR: 3.75,
  AED: 3.67,
  SEK: 10.7,
  NOK: 11.0,
  PLN: 4.05,
  TRY: 34.5,
  RUB: 98.0,
  UAH: 41.3,
  ARS: 1005,
};

export const ZERO_DECIMAL_CURRENCIES = new Set([
  'IDR', 'JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'RWF', 'ISK', 'HUF', 'KMF', 'GNF', 'XOF', 'XAF',
]);

export function currencyDecimals(code) {
  return ZERO_DECIMAL_CURRENCIES.has(String(code || 'USD').trim().toUpperCase()) ? 0 : 2;
}

export function roundCurrency(amount, code = 'USD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  const dec = currencyDecimals(code);
  if (dec === 0) return Math.round(n);
  return Math.round(n * 100) / 100;
}

/**
 * Convert `amount` from `fromCurrency` into `toCurrency` using USD-anchored cross rates.
 */
export function convertCrossCurrency(amount, fromCurrency, toCurrency, ratesPerUsd = BASELINE_RATES_PER_USD) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const from = String(fromCurrency || toCurrency || 'USD').trim().toUpperCase();
  const to = String(toCurrency || 'USD').trim().toUpperCase();
  if (from === to) return roundCurrency(n, to);

  const map = ratesPerUsd && typeof ratesPerUsd === 'object' ? ratesPerUsd : BASELINE_RATES_PER_USD;
  const fromPerUsd = Number(map[from]) > 0 ? Number(map[from]) : Number(BASELINE_RATES_PER_USD[from]);
  const toPerUsd = Number(map[to]) > 0 ? Number(map[to]) : Number(BASELINE_RATES_PER_USD[to]);
  if (!Number.isFinite(fromPerUsd) || fromPerUsd <= 0 || !Number.isFinite(toPerUsd) || toPerUsd <= 0) {
    return roundCurrency(n, to);
  }
  const usdValue = n / fromPerUsd;
  return roundCurrency(usdValue * toPerUsd, to);
}

/** Exact floating rate of 1 unit of `fromCurrency` expressed in `toCurrency`. */
export function unitCrossRate(fromCurrency, toCurrency, ratesPerUsd = BASELINE_RATES_PER_USD) {
  const from = String(fromCurrency || toCurrency || 'USD').trim().toUpperCase();
  const to = String(toCurrency || 'USD').trim().toUpperCase();
  if (from === to) return 1;
  const map = ratesPerUsd && typeof ratesPerUsd === 'object' ? ratesPerUsd : BASELINE_RATES_PER_USD;
  const fromPerUsd = Number(map[from]) > 0 ? Number(map[from]) : Number(BASELINE_RATES_PER_USD[from]);
  const toPerUsd = Number(map[to]) > 0 ? Number(map[to]) : Number(BASELINE_RATES_PER_USD[to]);
  if (!Number.isFinite(fromPerUsd) || fromPerUsd <= 0 || !Number.isFinite(toPerUsd) || toPerUsd <= 0) return 1;
  return toPerUsd / fromPerUsd;
}

function parseRatesPerUsd(data, providerLabel) {
  if (!data || typeof data !== 'object' || !data.rates || typeof data.rates !== 'object') {
    throw new Error(`malformed FX payload from ${providerLabel}`);
  }
  const ratesPerUsd = { USD: 1 };
  let count = 1;
  for (const [rawCode, rawVal] of Object.entries(data.rates)) {
    const code = String(rawCode).trim().toUpperCase();
    if (!ISO_CODE_RE.test(code)) continue;
    const perUsd = Number(rawVal);
    if (!Number.isFinite(perUsd) || perUsd <= 0) continue;
    ratesPerUsd[code] = code === 'USD' ? 1 : Number(perUsd.toFixed(6));
    count += 1;
  }
  if (count < 10) {
    throw new Error(`incomplete FX payload from ${providerLabel} (${count} currencies)`);
  }
  return {
    provider: providerLabel,
    ratesPerUsd,
    currencyCount: Object.keys(ratesPerUsd).length,
    fetchedAtMs: Date.now(),
  };
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'StreamTimerDesktop/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLiveRatesPerUsd({
  primaryUrl = process.env.FX_API_URL || PRIMARY_URL,
  fallbackUrl = process.env.FX_FALLBACK_URL || FALLBACK_URL,
  timeoutMs = 8000,
} = {}) {
  const sources = [
    { url: primaryUrl, label: primaryUrl.includes('open.er-api.com') ? 'open.er-api.com' : new URL(primaryUrl).host },
  ];
  if (fallbackUrl && fallbackUrl !== primaryUrl) {
    sources.push({
      url: fallbackUrl,
      label: fallbackUrl.includes('frankfurter') ? 'api.frankfurter.dev' : new URL(fallbackUrl).host,
    });
  }

  let lastErr = 'Unable to fetch exchange rates';
  for (const src of sources) {
    try {
      const data = await fetchJsonWithTimeout(src.url, timeoutMs);
      const parsed = parseRatesPerUsd(data, src.label);
      return { ok: true, ...parsed };
    } catch (err) {
      lastErr = `${src.label}: ${String(err && err.message || err)}`;
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Shared background auto-refresh coordinator (caches rates globally & updates active profile).
 */
export function createFxScheduler({
  readFxState,
  saveFxState,
  logger = () => {},
  autoFetch = process.env.FX_AUTO_FETCH !== '0',
} = {}) {
  let inflight = null;
  let timer = null;

  async function refreshNow({ force = true } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const cur = await readFxState();
        if (!force) {
          if (cur.autoUpdate === false) return { ok: true, skipped: true, reason: 'auto_update_disabled' };
          const intervalMs = Math.max(1, Number(cur.intervalHours) || 6) * 3_600_000;
          if (cur.lastUpdatedAtMs && (Date.now() - cur.lastUpdatedAtMs) < intervalMs) {
            return { ok: true, skipped: true, reason: 'fresh' };
          }
        }
        const fetched = await fetchLiveRatesPerUsd();
        if (!fetched.ok) {
          logger('fx_refresh_failed', { error: fetched.error });
          await saveFxState({ ok: false, error: fetched.error });
          return fetched;
        }
        const saved = await saveFxState(fetched);
        logger('fx_refreshed', {
          provider: fetched.provider,
          currencyCount: fetched.currencyCount,
        });
        return { ok: true, ...fetched, fx: saved };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function start() {
    if (!autoFetch) return;
    refreshNow({ force: false }).catch(() => {});
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => {
      refreshNow({ force: false }).catch(() => {});
    }, 15 * 60_000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { refreshNow, start, stop };
}
