// Reactive i18n & dynamic currency formatting helper.

import { LOCALES, LANGUAGE_META } from './locales.js';

const ZERO_DEC = new Set(['IDR', 'JPY', 'KRW', 'VND', 'CLP', 'HUF', 'PYG', 'ISK']);

let activeLang = 'en';
let activeCurrency = 'USD';

export function getLanguage() {
  return activeLang;
}

export function getCurrency() {
  return activeCurrency;
}

export function getIntlLocale(lang = activeLang) {
  return LANGUAGE_META.find((l) => l.code === lang)?.intl || 'en-US';
}

export function setLanguage(lang) {
  activeLang = LOCALES[lang] ? lang : 'en';
  document.documentElement.lang = activeLang;
  applyDomTranslations();
}

export function setBaseCurrency(cur) {
  activeCurrency = typeof cur === 'string' && /^[A-Z]{3}$/i.test(cur.trim())
    ? cur.trim().toUpperCase()
    : 'USD';
}

export function t(key, fallback = '') {
  const dict = LOCALES[activeLang] || LOCALES.en;
  return dict[key] ?? LOCALES.en[key] ?? fallback ?? key;
}

export function applyDomTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    const val = t(node.dataset.i18n);
    if (val) node.textContent = val;
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((node) => {
    const val = t(node.dataset.i18nPh);
    if (val) node.placeholder = val;
  });
}

export function fmtMoney(amount, currency = activeCurrency, lang = activeLang) {
  const cur = String(currency || activeCurrency || 'USD').trim().toUpperCase();
  const dec = ZERO_DEC.has(cur) ? 0 : 2;
  try {
    return new Intl.NumberFormat(getIntlLocale(lang), {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    }).format(Number(amount) || 0).replace(/\u00a0/g, ' ');
  } catch {
    return `${cur} ${(Number(amount) || 0).toFixed(dec)}`;
  }
}

export function fmtDateTime(ms, { full = false } = {}) {
  if (!ms || ms <= 0) return '—';
  return new Date(ms).toLocaleString(getIntlLocale(), full
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export { LANGUAGE_META };
