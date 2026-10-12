/**
 * 2.98: foreign currencies in the money lobby — the Bank of Israel's feed read strictly, the converter exact both ways (whole
 * millionths, one rounding, half up, to the currency's smallest coin), and the server's kept answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRates, convert, formatMinor, fxDay, fxDigits, fxName, fxShort, inverseText, parseAmount, parseBoiRates, rateText, type FxRate } from '../src/features/finance/fx';
import { BOI_RATES_URL, boiRates, resetFxRates } from '../src/lib/server/fx';

const feed = {
  exchangeRates: [
    { key: 'GBP', currentExchangeRate: 4.805, currentChange: -0.12, unit: 1, lastUpdate: '2026-10-12T12:23:17.1063397Z' },
    { key: 'JPY', currentExchangeRate: 2.4983, currentChange: 0.05, unit: 100, lastUpdate: '2026-10-12T12:23:17.1063397Z' },
    { key: 'USD', currentExchangeRate: 3.717, currentChange: 0.19, unit: 1, lastUpdate: '2026-10-12T12:23:17.1063397Z' },
    { key: 'EUR', currentExchangeRate: 4.051, currentChange: 0.02, unit: 1, lastUpdate: '2026-10-12T12:23:17.1063397Z' },
    { key: 'JOD', currentExchangeRate: 5.243, currentChange: 0.18, unit: 1, lastUpdate: '2026-10-12T12:23:17Z' },
    { key: 'LBP', currentExchangeRate: '0.0415', currentChange: 0, unit: 10, lastUpdate: '2026-10-12T12:23:17' },
    { key: 'USD', currentExchangeRate: 9.99, unit: 1, lastUpdate: '2026-10-12T12:23:17Z' },
    { key: 'XXX', currentExchangeRate: 0, unit: 1, lastUpdate: '2026-10-12T12:23:17Z' },
    { key: 'ILS', currentExchangeRate: 1, unit: 1, lastUpdate: '2026-10-12T12:23:17Z' },
    { key: 'CHF', currentExchangeRate: 4.6, unit: 1.5, lastUpdate: '2026-10-12T12:23:17Z' },
    { key: 'SEK', currentExchangeRate: 0.35, unit: 1, lastUpdate: 'yesterday' },
    { key: 'dkk', currentExchangeRate: 0.543, unit: 1, lastUpdate: '2026-10-12T12:23:17Z' },
    { key: 'NOK1', currentExchangeRate: 0.34, unit: 1, lastUpdate: '2026-10-12T12:23:17Z' },
  ],
};
const usd: FxRate = { code: 'USD', rate: 3.717, unit: 1, updated: '2026-10-12T12:23:17.106Z' };
const jpy: FxRate = { code: 'JPY', rate: 2.4983, unit: 100, updated: '2026-10-12T12:23:17.106Z' };
const jod: FxRate = { code: 'JOD', rate: 5.243, unit: 1, updated: '2026-10-12T12:23:17.000Z' };
const M = (n: number) => BigInt(Math.round(n * 1_000_000));

test("the bank's feed: what is whole, once per currency, the common ones first — nothing broken, guessed or doubled", () => {
  const r = parseBoiRates(feed);
  assert.deepEqual(r.map((x) => x.code), ['USD', 'EUR', 'GBP', 'JPY', 'DKK', 'JOD', 'LBP']);
  assert.deepEqual(r[0], usd, 'the first USD is kept, the second is a duplicate; the time is cut to milliseconds');
  assert.deepEqual(r.find((x) => x.code === 'JPY'), jpy, 'the yen per 100');
  assert.deepEqual(r.find((x) => x.code === 'LBP'), { code: 'LBP', rate: 0.0415, unit: 10, updated: '2026-10-12T12:23:17.000Z' }, 'a numeric string; no zone = UTC');
  for (const bad of [null, undefined, 'x', 42, {}, { exchangeRates: 'no' }, { exchangeRates: [] }, { exchangeRates: [{ key: 'USD' }] }]) {
    assert.deepEqual(parseBoiRates(bad), [], String(JSON.stringify(bad)));
  }
  assert.deepEqual(cleanRates([{ code: 'usd', rate: 3.7, unit: 1, updated: '2026-10-12T12:00:00.000Z' }, { code: 'EUR', rate: -1, unit: 1, updated: '2026-10-12T12:00:00.000Z' }]),
    [{ code: 'USD', rate: 3.7, unit: 1, updated: '2026-10-12T12:00:00.000Z' }], 'the screen checks the server answer the same way');
});

test('a typed amount: digits, one point, commas only between thousands — "1,5" is not one and a half, it is nothing', () => {
  assert.equal(parseAmount('100'), M(100));
  assert.equal(parseAmount(' 1,234.5 '), M(1234.5));
  assert.equal(parseAmount('1 000'), M(1000));
  assert.equal(parseAmount('.5'), M(0.5));
  assert.equal(parseAmount('7.'), M(7));
  assert.equal(parseAmount('0.000001'), BigInt(1));
  assert.equal(parseAmount('999999999999.99'), BigInt('999999999999990000'));
  for (const bad of ['', ' ', '.', '-5', '1,5', '1,23', '12,34.5', '1.2.3', '1e3', 'abc', '0.0000001', '1234567890123', '₪5']) assert.equal(parseAmount(bad), null, bad);
});

test('to shekels: rate ÷ unit, rounded once, half up, to agorot — the yen per 100', () => {
  assert.equal(formatMinor(convert(M(100), usd, 'toIls').minor, 2), '371.70');
  assert.deepEqual(convert(M(0.5), usd, 'toIls'), { minor: BigInt(186), digits: 2 }, '1.8585 → 1.86 (half up)');
  assert.deepEqual(convert(M(1000), jpy, 'toIls'), { minor: BigInt(2498), digits: 2 }, '1,000 yen = 24.983 → 24.98');
  assert.deepEqual(convert(M(0), usd, 'toIls'), { minor: BigInt(0), digits: 2 });
  assert.equal(formatMinor(convert(M(1234567.89), usd, 'toIls').minor, 2), '4,588,888.85', '1,234,567.89 × 3.717 = 4,588,888.84713');
});

test("from shekels: to the currency's smallest coin — the dollar's cents, the yen whole, the dinar's fils", () => {
  assert.deepEqual(convert(M(371.7), usd, 'fromIls'), { minor: BigInt(10000), digits: 2 }, 'back to exactly 100.00');
  assert.deepEqual(convert(M(100), usd, 'fromIls'), { minor: BigInt(2690), digits: 2 }, '100 ÷ 3.717 = 26.9034…');
  assert.deepEqual(convert(M(100), jpy, 'fromIls'), { minor: BigInt(4003), digits: 0 }, '100 × 100 ÷ 2.4983 = 4,002.72…');
  assert.deepEqual(convert(M(100), jod, 'fromIls'), { minor: BigInt(19073), digits: 3 }, '100 ÷ 5.243 = 19.07305…');
  assert.equal(fxDigits('JPY'), 0);
  assert.equal(fxDigits('JOD'), 3);
  assert.equal(fxDigits('EUR'), 2);
});

test('numbers written the way the money screens write them; the rate as the bank publishes it; its Israeli date', () => {
  assert.equal(formatMinor(BigInt(123456789), 2), '1,234,567.89');
  assert.equal(formatMinor(BigInt(5), 2), '0.05');
  assert.equal(formatMinor(BigInt(4003), 0), '4,003');
  assert.equal(formatMinor(BigInt(19073), 3), '19.073');
  assert.equal(formatMinor(BigInt(-150), 2), '-1.50');
  assert.equal(rateText(usd), '3.717');
  assert.equal(rateText(jpy), '2.4983');
  assert.equal(inverseText(usd), '0.2690');
  assert.equal(inverseText(jpy), '40.0272');
  assert.equal(fxDay(usd), '2026-10-12');
  assert.equal(fxDay({ updated: '2026-10-11T22:30:00.000Z' }), '2026-10-12', 'after midnight in Israel');
  assert.equal(fxName('USD'), 'דולר ארה״ב');
  assert.equal(fxName('XYZ'), 'XYZ');
  assert.equal(fxShort('GBP'), 'ליש״ט');
  assert.equal(fxShort('CHF'), 'פרנק שוויצרי');
});

test('the server: the bank once per 30 minutes; the last good answer for up to 3 days when it does not answer; then nothing', async () => {
  resetFxRates();
  const calls: string[] = [];
  let answer: () => Response = () => Response.json(feed);
  const fetcher = (async (url: string) => { calls.push(url); return answer(); }) as unknown as typeof fetch;
  const t0 = Date.UTC(2026, 9, 12, 13, 0);
  const first = await boiRates(t0, fetcher);
  assert.equal(first?.[0].code, 'USD');
  assert.deepEqual(calls, [BOI_RATES_URL]);
  assert.equal((await boiRates(t0 + 29 * 60_000, fetcher))?.length, 7, 'kept');
  assert.equal(calls.length, 1, 'no second call within 30 minutes');
  answer = () => new Response('busy', { status: 503 });
  assert.equal((await boiRates(t0 + 31 * 60_000, fetcher))?.length, 7, 'the bank is down: the last good answer (its dates are shown)');
  assert.equal(calls.length, 2);
  answer = () => Response.json({ exchangeRates: [] });
  assert.equal((await boiRates(t0 + 2 * 24 * 60 * 60_000, fetcher))?.length, 7, 'an empty answer does not replace a good one');
  assert.equal(await boiRates(t0 + 3 * 24 * 60 * 60_000 + 1, fetcher), null, 'after 3 days: nothing — never a guessed rate');
  answer = () => { throw new Error('offline'); };
  resetFxRates();
  assert.equal(await boiRates(t0, fetcher), null, 'no answer and nothing kept');
  answer = () => new Response('x'.repeat(300 * 1024));
  assert.equal(await boiRates(t0, fetcher), null, 'a body too big is not read');
  answer = () => new Response('<html>');
  assert.equal(await boiRates(t0, fetcher), null, 'not JSON');
  resetFxRates();
});
