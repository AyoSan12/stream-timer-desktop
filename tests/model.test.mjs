import crypto from 'node:crypto';
import {
  applyCommand, snapshotOf, effectiveRemainingMs,
  buildDefaultRulesForCurrency, resolveTransactionCredit,
  matchYoutubeLevel, normalizeYoutubeLevelKey,
} from '../engine/domain.js';
import { convertCrossCurrency, BASELINE_RATES_PER_USD } from '../engine/fx.js';
import {
  buildDefaultFinanceConfig, calculateFinanceBreakdown, buildFinanceReport,
  exportFinanceCsv, exportFinanceJson, exportFinanceMarkdown,
  exportFinanceHtmlReport, exportFinanceXlsx,
} from '../engine/finance.js';
import { normalizeStreamlabsEvent } from '../engine/sockets/streamlabs.js';
import { parseWebhookRequest } from '../engine/sockets/global-sockets.js';
import { DONATION_PLATFORMS } from '../engine/platforms.js';
import { assert, eq, runCases, summarize } from './harness.mjs';

const cases = [];

cases.push({
  id: 'M1-timer-anti-drift-exact-milliseconds',
  fn() {
    const T0 = 1_750_000_000_000;
    let s = { state: 'paused', deadlineMs: null, pausedRemainingMs: 60_000, revision: 0, updatedAtMs: T0 };
    s = applyCommand(s, { type: 'resume' }, T0).state;
    eq(s.deadlineMs, T0 + 60_000, 'resume anchors exact deadline');
    s = applyCommand(s, { type: 'add', amountMs: 600_000 }, T0 + 12_345).state;
    eq(s.deadlineMs, T0 + 660_000, 'add extends deadline directly with 0 ms drift');
    s = applyCommand(s, { type: 'pause' }, T0 + 25_000).state;
    eq(s.pausedRemainingMs, 635_000, 'pause freezes exact remaining ms');
    const snap = snapshotOf(s, T0 + 999_999);
    eq(snap.remainingMs, 635_000, 'paused timer never drifts');
    return { ok: true };
  },
});

cases.push({
  id: 'M2-dynamic-base-currency-cross-fx-and-tiers',
  fn() {
    const rates = { ...BASELINE_RATES_PER_USD, USD: 1, JPY: 150, IDR: 18_000, EUR: 0.9, BRL: 5, KRW: 1350 };
    // Japanese streamer (baseCurrency = JPY) receives $10 USD Super Chat -> ¥1,500 JPY
    eq(convertCrossCurrency(10, 'USD', 'JPY', rates), 1500, '$10 USD -> 1,500 JPY');
    // US streamer (baseCurrency = USD) receives ¥1,500 JPY Super Chat -> $10.00 USD
    eq(convertCrossCurrency(1500, 'JPY', 'USD', rates), 10, '1,500 JPY -> $10.00 USD');
    // Indonesian streamer (baseCurrency = IDR) receives 20 BRL LivePix -> Rp 72.000
    eq(convertCrossCurrency(20, 'BRL', 'IDR', rates), 72_000, '20 BRL -> Rp 72.000');

    const usdRules = buildDefaultRulesForCurrency('USD', rates);
    const sc = normalizeStreamlabsEvent({
      type: 'superchat',
      for: 'youtube_account',
      message: [{ id: 'sc-1', name: 'Kenji', amount: 1_500_000_000, displayString: '¥1,500', currency: 'JPY' }],
    }, usdRules, { ratesPerUsd: rates });
    eq(sc[0].grossAmount, 10, '¥1,500 micros -> $10 USD base');
    eq(sc[0].creditMs, 3_600_000, '$10 USD hits $10 tier (1h)');

    const jpyRules = buildDefaultRulesForCurrency('JPY', rates);
    const jpyTip = resolveTransactionCredit({ kind: 'cash_tip', amount: 20, currency: 'USD' }, jpyRules, { ratesPerUsd: rates });
    eq(jpyTip.grossAmount, 3000, '$20 USD -> ¥3,000 JPY');
    eq(jpyTip.creditMs, 3_600_000, '¥3,000 hits ¥2,000 JPY tier (1h)');
    return { usdGross: sc[0].grossAmount, jpyGross: jpyTip.grossAmount };
  },
});

cases.push({
  id: 'M3-global-regional-webhooks-and-country-catalog',
  fn() {
    assert(DONATION_PLATFORMS.length >= 15, 'at least 15 global & regional platforms cataloged');
    const rates = { ...BASELINE_RATES_PER_USD, USD: 1, KRW: 1350, BRL: 5, TWD: 30, IDR: 16_000 };
    const usdRules = buildDefaultRulesForCurrency('USD', rates);

    // Ko-fi form-urlencoded with verification_token
    const kofiPayload = `data=${encodeURIComponent(JSON.stringify({ verification_token: 'kofi-sec', from_name: 'Maya', amount: '12.50', currency: 'USD', message: 'Coffee!', kofi_transaction_id: 'kf-1' }))}`;
    const kofi = parseWebhookRequest({ providerId: 'kofi', rawBody: kofiPayload, headers: { 'content-type': 'application/x-www-form-urlencoded' }, secret: 'kofi-sec', rulesConfig: usdRules, fxState: { ratesPerUsd: rates } });
    assert(kofi.ok, 'Ko-fi verified & parsed');
    eq(kofi.event.grossAmount, 12.5, 'Ko-fi $12.50 preserved');

    // Naver Chzzk Korea Cheese (13,500 KRW -> $10 USD)
    const chzzkRaw = JSON.stringify({ data: { nickname: 'Minji', payAmount: 13500, currency: 'KRW', donationText: 'Cheese!', eventId: 'cz-1' } });
    const chzzk = parseWebhookRequest({ providerId: 'chzzk', rawBody: chzzkRaw, headers: { 'content-type': 'application/json' }, urlTokenValid: true, rulesConfig: usdRules, fxState: { ratesPerUsd: rates } });
    assert(chzzk.ok, 'Chzzk parsed');
    eq(chzzk.event.grossAmount, 10, '13,500 KRW -> $10.00 USD');

    // LivePix Brazil (5000 cents = 50 BRL -> $10 USD)
    const pixRaw = JSON.stringify({ resource: { id: 'px-1', username: 'Lucas', amount: 5000, currency: 'BRL', message: 'Salve!' } });
    const pix = parseWebhookRequest({ providerId: 'livepix', rawBody: pixRaw, headers: { 'content-type': 'application/json' }, urlTokenValid: true, rulesConfig: usdRules, fxState: { ratesPerUsd: rates } });
    assert(pix.ok, 'LivePix parsed');
    eq(pix.event.grossAmount, 10, '5000 cents (50 BRL) -> $10.00 USD');

    // ECPay Taiwan (300 TWD -> $10 USD)
    const ecRaw = 'MerchantTradeNo=ec-1&TradeAmt=300&CustomField1=Wei&CustomField2=GG';
    const ec = parseWebhookRequest({ providerId: 'ecpay', rawBody: ecRaw, headers: { 'content-type': 'application/x-www-form-urlencoded' }, urlTokenValid: true, rulesConfig: usdRules, fxState: { ratesPerUsd: rates } });
    assert(ec.ok, 'ECPay form parsed with valid URL token');
    eq(ec.event.grossAmount, 10, '300 TWD -> $10.00 USD');

    return { platforms: DONATION_PLATFORMS.length };
  },
});

cases.push({
  id: 'M5-production-webhook-protocols-all-platforms',
  fn() {
    const rates = { ...BASELINE_RATES_PER_USD, USD: 1, IDR: 16000, BRL: 5, TWD: 30 };
    const idrRules = buildDefaultRulesForCurrency('IDR', rates);
    const usdRules = buildDefaultRulesForCurrency('USD', rates);

    // 1. Tako.id: exact official X-Tako-Signature over JSON.stringify(body) EVEN when raw HTTP body has pretty whitespace!
    const takoObj = { event: 'payment.success', data: { id: 'tako-001', amount: 50000, price: 50000, gifterName: 'Raka', message: 'Semangat!' } };
    const takoPrettyRaw = JSON.stringify(takoObj, null, 2);
    const takoSig = crypto.createHmac('sha256', 'tako-token-xyz').update(JSON.stringify(takoObj)).digest('hex');
    const takoOk = parseWebhookRequest({
      providerId: 'tako',
      rawBody: takoPrettyRaw,
      headers: { 'content-type': 'application/json', 'x-tako-signature': takoSig },
      platformSecret: 'tako-token-xyz',
      urlTokenValid: true,
      rulesConfig: idrRules,
      fxState: { ratesPerUsd: rates },
    });
    assert(takoOk.ok, 'Tako.id nested payment.success + X-Tako-Signature (JSON.stringify canonical) accepted');
    eq(takoOk.event.grossAmount, 50000, 'Tako amount = 50000 IDR');
    eq(takoOk.event.payload.gifterName, 'Raka', 'Tako gifterName extracted');

    // 2. Tako.id with empty token -> secured by URL path token
    const takoOpen = parseWebhookRequest({
      providerId: 'tako',
      rawBody: JSON.stringify({ id: 'tako-002', gifterName: 'Nadia', amount: 25000, message: 'Test' }),
      headers: { 'content-type': 'application/json' },
      platformSecret: '',
      urlTokenValid: true,
      rulesConfig: idrRules,
      fxState: { ratesPerUsd: rates },
    });
    assert(takoOpen.ok, 'Tako.id with empty webhook token accepted via secret URL path');
    // Without URL token AND without secret -> rejected 403
    const takoNoAuth = parseWebhookRequest({
      providerId: 'tako',
      rawBody: JSON.stringify({ id: 'tako-003', amount: 25000 }),
      headers: { 'content-type': 'application/json' },
      platformSecret: '',
      urlTokenValid: false,
      rulesConfig: idrRules,
      fxState: { ratesPerUsd: rates },
    });
    eq(takoNoAuth.status, 403, 'Unauthorized hit without URL token or secret rejected (403)');

    // 3. Saweria: real unsigned JSON payload secured by secret URL path
    const saw = parseWebhookRequest({
      providerId: 'saweria',
      rawBody: JSON.stringify({ version: '2022.01', id: 'saw-99', type: 'donation', amount_raw: 69420, cut: 3471, donator_name: 'Someguy', message: 'Hi!' }),
      headers: { 'content-type': 'application/json' },
      platformSecret: '',
      urlTokenValid: true,
      rulesConfig: idrRules,
      fxState: { ratesPerUsd: rates },
    });
    assert(saw.ok, 'Saweria real unsigned webhook accepted via secret URL path');
    eq(saw.event.grossAmount, 69420, 'Saweria amount_raw = 69420 IDR');

    // 4. Buy Me a Coffee: official `response` wrapper + x-signature-sha256
    const bmcRaw = JSON.stringify({ response: { support_id: 777, supporter_name: 'Elena', total_amount: '15.00', currency: 'USD', support_note: 'Coffee!' } });
    const bmcSig = crypto.createHmac('sha256', 'bmc-sec').update(bmcRaw).digest('hex');
    const bmc = parseWebhookRequest({
      providerId: 'buymeacoffee',
      rawBody: bmcRaw,
      headers: { 'content-type': 'application/json', 'x-signature-sha256': bmcSig },
      platformSecret: 'bmc-sec',
      rulesConfig: usdRules,
      fxState: { ratesPerUsd: rates },
    });
    assert(bmc.ok, 'Buy Me a Coffee response wrapper + x-signature-sha256 accepted');
    eq(bmc.event.grossAmount, 15, 'BMC $15.00 USD');

    // 5. Tiltify v5: Base64 HMAC-SHA256 of `${X-Tiltify-Timestamp}.${rawBody}`
    const tiltRaw = JSON.stringify({ data: { id: 'tf-1', donor_name: 'CharityFan', amount: { value: '25.00', currency: 'USD' }, donor_comment: 'For kids!' } });
    const tiltTs = '1795338000';
    const tiltSig = crypto.createHmac('sha256', 'tilt-key').update(`${tiltTs}.${tiltRaw}`).digest('base64');
    const tilt = parseWebhookRequest({
      providerId: 'tiltify',
      rawBody: tiltRaw,
      headers: { 'content-type': 'application/json', 'x-tiltify-timestamp': tiltTs, 'x-tiltify-signature': tiltSig },
      platformSecret: 'tilt-key',
      rulesConfig: usdRules,
      fxState: { ratesPerUsd: rates },
    });
    assert(tilt.ok, 'Tiltify v5 timestamp.rawBody Base64 HMAC accepted');
    eq(tilt.event.grossAmount, 25, 'Tiltify $25.00 USD');

    // 6. LivePix (BR): integer cents `1000` -> R$ 10.00 BRL -> $2.00 USD (at 5 BRL/USD)
    const pix = parseWebhookRequest({
      providerId: 'livepix',
      rawBody: JSON.stringify({ id: 'pix-1', username: 'Joao', message: 'Salve!', amount: 1000, currency: 'BRL' }),
      headers: { 'content-type': 'application/json' },
      urlTokenValid: true,
      rulesConfig: usdRules,
      fxState: { ratesPerUsd: rates },
    });
    assert(pix.ok, 'LivePix cents webhook parsed');
    eq(pix.event.payload.originalAmount, 10, 'LivePix 1000 cents converted to 10.00 BRL (not 1000!)');
    eq(pix.event.grossAmount, 2, '10 BRL -> $2.00 USD');

    // 7. SociaBuzz nested data + x-webhook-token
    const sb = parseWebhookRequest({
      providerId: 'sociabuzz',
      rawBody: JSON.stringify({ event: 'tribe_support', data: { transaction_id: 'sb-1', amount_raw: 32000, currency: 'IDR', supporter: 'Dina', message: 'Gas!' } }),
      headers: { 'content-type': 'application/json', 'x-webhook-token': 'sb-tok' },
      platformSecret: 'sb-tok',
      rulesConfig: usdRules,
      fxState: { ratesPerUsd: rates },
    });
    assert(sb.ok, 'SociaBuzz nested data + x-webhook-token accepted');
    eq(sb.event.grossAmount, 2, '32000 IDR -> $2.00 USD');

    // 8. Trakteer HTTP X-Webhook-Token
    const trk = parseWebhookRequest({
      providerId: 'trakteer',
      rawBody: JSON.stringify({ transaction_id: 'trk-1', type: 'tip', supporter_name: 'Egis', supporter_message: 'Mantap', price: 16000, quantity: 1 }),
      headers: { 'content-type': 'application/json', 'x-webhook-token': 'trk-tok' },
      platformSecret: 'trk-tok',
      rulesConfig: usdRules,
      fxState: { ratesPerUsd: rates },
    });
    assert(trk.ok, 'Trakteer HTTP X-Webhook-Token accepted');
    eq(trk.event.grossAmount, 1, '16000 IDR -> $1.00 USD');

    return { verifiedProtocols: 8 };
  },
});

cases.push({
  id: 'M4-dynamic-currency-finance-and-5-exporters',
  fn() {
    const usdFin = buildDefaultFinanceConfig('USD');
    // Streamlabs Tip $100: 2.9% ($2.90) + $0.30 fixed = $3.20 deduction -> Net $96.80
    const sl = calculateFinanceBreakdown(100, 'streamlabs', usdFin);
    eq(sl.paymentFee, 2.9, '2.9% payment fee = $2.90');
    eq(sl.fixedFee, 0.3, 'fixed fee = $0.30');
    eq(sl.totalDeductions, 3.2, 'total deductions = $3.20');
    eq(sl.netAmount, 96.8, 'net = $96.80');

    // Chzzk 20% platform cut on $50 = $10 -> Net $40
    const cz = calculateFinanceBreakdown(50, 'chzzk', usdFin);
    eq(cz.platformFee, 10, 'Chzzk 20% = $10');
    eq(cz.netAmount, 40, 'Chzzk Net = $40');

    const rep = buildFinanceReport([
      { eventId: 'e1', provider: 'streamlabs', grossAmount: 100, currency: 'USD', creditMs: 3_600_000, appliedAtMs: 1000, payload: { gifterName: 'Sam', originalAmount: 100, originalCurrency: 'USD' } },
      { eventId: 'e2', provider: 'chzzk', grossAmount: 50, currency: 'USD', creditMs: 3_600_000, appliedAtMs: 2000, payload: { gifterName: 'Minji', originalAmount: 67500, originalCurrency: 'KRW' } },
    ], [{ sessionId: 'session-1', seqNum: 1, label: 'Global Stream #1', startedAtMs: 0, endedAtMs: null, createdAtMs: 0 }], usdFin, { session: 'current' });

    eq(rep.summary.grossAmount, 150, 'Total gross = $150');
    eq(rep.summary.totalDeductions, 13.2, 'Total deductions = $13.20');
    eq(rep.summary.netAmount, 136.8, 'Total net = $136.80 (cent-safe)');

    const xlsx = exportFinanceXlsx(rep);
    eq(xlsx[0], 0x50, 'XLSX ZIP P');
    eq(xlsx[1], 0x4b, 'XLSX ZIP K');
    assert(exportFinanceCsv(rep).includes('Gross (USD)'), 'CSV uses dynamic USD header');
    assert(JSON.parse(exportFinanceJson(rep)).baseCurrency === 'USD', 'JSON carries USD baseCurrency');
    assert(exportFinanceMarkdown(rep).includes('Global Stream #1'), 'Markdown ready');
    assert(exportFinanceHtmlReport(rep).includes('window.print()'), 'HTML print statement ready');
    return { netUsd: rep.summary.netAmount, xlsxBytes: xlsx.length };
  },
});

cases.push({
  id: 'M6-youtube-membership-4-layer-matching-simulations',
  fn() {
    const levels = [
      { id: 'yt-1', name: 'Supporter', price: 10000, creditMode: 'fixed_time', fixedMs: 300_000, isDefault: true, aliases: [] },
      { id: 'yt-2', name: 'Sultan VIP', price: 50000, creditMode: 'fixed_time', fixedMs: 900_000, isDefault: false, aliases: ['Anak Sultan'] },
      { id: 'yt-3', name: 'Tier 1', price: 10000, creditMode: 'fixed_time', fixedMs: 300_000, isDefault: false, aliases: [] },
      { id: 'yt-4', name: 'チャンピオン', price: 150000, creditMode: 'fixed_time', fixedMs: 3_600_000, isDefault: false, aliases: [] },
      { id: 'yt-5', name: 'Level 10', price: 20000, creditMode: 'fixed_time', fixedMs: 600_000, isDefault: false, aliases: [] },
    ];

    // 1. Exact case-insensitive
    const m1 = matchYoutubeLevel('  supporter ', levels);
    eq(m1.matchStatus, 'exact', 'exact match ignores case & outer spaces');
    eq(m1.level.id, 'yt-1', 'matched yt-1');

    // 2. Emoji & punctuation normalization (EN & Unicode JP)
    const m2 = matchYoutubeLevel('👑  Sultan VIP!! ', levels);
    eq(m2.matchStatus, 'normalized', 'emoji + punctuation stripped for normalized match');
    eq(m2.level.id, 'yt-2', 'matched Sultan VIP');

    const mJp = matchYoutubeLevel('⭐ チャンピオン ⭐', levels);
    eq(mJp.matchStatus, 'normalized', 'Unicode Japanese level matched after stripping star emojis');
    eq(mJp.level.id, 'yt-4', 'matched チャンピオン');

    // 3. Saved alias
    const mAlias = matchYoutubeLevel('🔥 Anak Sultan', levels);
    eq(mAlias.matchStatus, 'alias', 'normalized alias match succeeds');
    eq(mAlias.level.id, 'yt-2', 'alias maps to Sultan VIP');

    // 4. Safe 1-char typo (length >= 5, same digit signature, unique)
    const mTypo = matchYoutubeLevel('Suporter', levels);
    eq(mTypo.matchStatus, 'fuzzy_safe', 'safe 1-char typo Suporter -> Supporter');
    eq(mTypo.level.id, 'yt-1', 'matched Supporter');

    // 5. CRITICAL anti-false-positive numeric guard ("Tier 2" must NOT match "Tier 1", "Level 20" must NOT match "Level 10")
    const mNum1 = matchYoutubeLevel('Tier 2', levels);
    eq(mNum1.matchStatus, 'unmatched_fallback', 'Tier 2 NEVER false-matches Tier 1');
    eq(mNum1.level.id, 'yt-1', 'falls back safely to Default');
    eq(mNum1.rawLevelName, 'Tier 2', 'preserves verbatim rawLevelName');

    const mNum2 = matchYoutubeLevel('Level 20', levels);
    eq(mNum2.matchStatus, 'unmatched_fallback', 'Level 20 NEVER false-matches Level 10');

    // 6. Completely unknown tier -> zero-drop fallback + unmatched_fallback flag
    const mUnk = matchYoutubeLevel('Keluarga Cemara', levels);
    eq(mUnk.matchStatus, 'unmatched_fallback', 'unknown tier triggers unmatched_fallback');
    eq(mUnk.level.id, 'yt-1', 'zero-drop fallback to Default');
    eq(mUnk.fallbackLevelName, 'Supporter', 'records fallbackLevelName');

    // 7. Empty string -> empty_default (no noisy alert)
    const mEmpty = matchYoutubeLevel('', levels);
    eq(mEmpty.matchStatus, 'empty_default', 'empty payload uses empty_default quietly');
    eq(normalizeYoutubeLevelKey('  👑 VIP!!  '), 'vip', 'normalizeYoutubeLevelKey strips emojis cleanly');

    return { testedStages: 7 };
  },
});

const results = await runCases(cases);
console.log(JSON.stringify(summarize(results)));
for (const r of results.filter((x) => x.verdict !== 'pass')) console.error(r);
process.exit(results.some((x) => x.verdict === 'fail') ? 1 : 0);
