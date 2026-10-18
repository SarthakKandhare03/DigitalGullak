import { describe, expect, it } from 'vitest';
import { amountInWords, ceilDiv, formatINR, parseRupeesToPaise, progressPercent } from './money';
import { anchorFor, describeFrequency, monthsUntil, occurrenceAfter, occurrenceOnOrAfter, todayInIST, upcomingOccurrences } from './dates';

describe('formatINR', () => {
  it('uses Indian lakh/crore grouping', () => {
    expect(formatINR(125_000_00)).toBe('₹1,25,000');
    expect(formatINR(1_23_45_678_90)).toBe('₹1,23,45,678.90');
    expect(formatINR(5)).toBe('₹0.05');
    expect(formatINR(0)).toBe('₹0');
  });
  it('handles paise display and signs', () => {
    expect(formatINR(50_000, { paise: 'always' })).toBe('₹500.00');
    expect(formatINR(-1_250_50)).toBe('−₹1,250.50');
    expect(formatINR(100_00, { signed: true })).toBe('+₹100');
  });
  it('rejects non-integer amounts', () => {
    expect(() => formatINR(10.5)).toThrow();
  });
});

describe('parseRupeesToPaise', () => {
  it('parses rupee strings into integer paise without floats', () => {
    expect(parseRupeesToPaise('1,250.5')).toEqual({ ok: true, paise: 125050 });
    expect(parseRupeesToPaise('₹ 500')).toEqual({ ok: true, paise: 50000 });
    expect(parseRupeesToPaise('0.29', { minPaise: 1 })).toEqual({ ok: true, paise: 29 });
    expect(parseRupeesToPaise('19.99')).toEqual({ ok: true, paise: 1999 });
  });
  it('rejects bad input and enforces limits', () => {
    expect(parseRupeesToPaise('').ok).toBe(false);
    expect(parseRupeesToPaise('12.345').ok).toBe(false);
    expect(parseRupeesToPaise('-5').ok).toBe(false);
    expect(parseRupeesToPaise('abc').ok).toBe(false);
    expect(parseRupeesToPaise('0.50').ok).toBe(false); // below ₹1 minimum
    expect(parseRupeesToPaise('100001').ok).toBe(false); // above ₹1,00,000 maximum
  });
});

describe('amountInWords', () => {
  it('uses the Indian numbering system', () => {
    expect(amountInWords(1_250_00)).toBe('One thousand two hundred fifty rupees');
    expect(amountInWords(2_50_000_50)).toBe('Two lakh fifty thousand rupees and fifty paise');
    expect(amountInWords(1_00_00_000_00)).toBe('One crore rupees');
    expect(amountInWords(100)).toBe('One rupee');
    expect(amountInWords(45)).toBe('Forty-five paise');
  });
});

describe('integer helpers', () => {
  it('computes progress and ceilings with integers', () => {
    expect(progressPercent(13_800_00, 50_000_00)).toBe(27);
    expect(progressPercent(60_000_00, 50_000_00)).toBe(100);
    expect(ceilDiv(10, 3)).toBe(4);
    expect(ceilDiv(9, 3)).toBe(3);
  });
});

describe('schedule dates', () => {
  it('computes the IST calendar date', () => {
    expect(todayInIST(new Date('2026-10-18T19:00:00Z'))).toBe('2026-10-19');
    expect(todayInIST(new Date('2026-10-18T18:00:00Z'))).toBe('2026-10-18');
  });
  it('keeps monthly anchors and clamps to month end', () => {
    const anchor = anchorFor('monthly', '2026-01-31');
    expect(upcomingOccurrences('monthly', anchor, '2026-01-31', '2026-01-31', 4)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });
  it('handles weekly and daily schedules', () => {
    const anchor = anchorFor('weekly', '2026-10-19'); // Monday
    expect(occurrenceOnOrAfter('weekly', anchor, '2026-10-19', '2026-10-21')).toBe('2026-10-26');
    expect(occurrenceAfter('daily', null, '2026-10-18', '2026-10-31')).toBe('2026-11-01');
    expect(describeFrequency('weekly', anchor)).toBe('every Monday');
    expect(describeFrequency('monthly', 31)).toContain('last day');
  });
  it('counts months until a target date', () => {
    expect(monthsUntil('2026-10-18', '2027-01-18')).toBe(3);
    expect(monthsUntil('2026-10-18', '2027-01-19')).toBe(4);
    expect(monthsUntil('2026-10-18', '2026-10-20')).toBe(1);
  });
});
