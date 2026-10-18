/**
 * Money helpers. Every amount in Digital Gullak is an integer number of paise
 * (₹1 = 100 paise). Never use floating-point arithmetic for money: rupees and
 * paise are split with integer remainder/division only.
 */

export const PAISE_PER_RUPEE = 100;

/** Smallest single demo transaction: ₹1. */
export const MIN_TRANSFER_PAISE = 100;
/** Largest single demo transaction: ₹1,00,000. */
export const MAX_TRANSFER_PAISE = 1_00_000 * PAISE_PER_RUPEE;
/** Largest goal target: ₹10,00,00,000 (10 crore). */
export const MAX_TARGET_PAISE = 10_00_00_000 * PAISE_PER_RUPEE;
/**
 * Demo cap per scheduled contribution: ₹15,000. Mirrors the usual RBI limit for
 * recurring debits processed without an extra authentication factor.
 */
export const MAX_SCHEDULE_PAISE = 15_000 * PAISE_PER_RUPEE;

export function isPaise(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function splitPaise(paise: number): { rupees: number; fraction: number } {
  const abs = Math.abs(paise);
  const fraction = abs % PAISE_PER_RUPEE;
  // (abs - fraction) is an exact multiple of 100, so this division is exact.
  return { rupees: (abs - fraction) / PAISE_PER_RUPEE, fraction };
}

const groupingFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export interface FormatINROptions {
  /** 'auto' hides ".00" for whole rupees; 'always' shows two decimals. */
  paise?: 'auto' | 'always';
  /** Prefix positive amounts with "+". */
  signed?: boolean;
}

/** Formats paise as Indian rupees with lakh/crore grouping, e.g. ₹1,25,000.50 */
export function formatINR(paise: number, options: FormatINROptions = {}): string {
  if (!isPaise(paise)) throw new TypeError('Amount must be an integer number of paise');
  const { rupees, fraction } = splitPaise(paise);
  let text = `₹${groupingFormatter.format(rupees)}`;
  if (options.paise === 'always' || fraction !== 0) {
    text += `.${String(fraction).padStart(2, '0')}`;
  }
  if (paise < 0) return `−${text}`;
  if (options.signed && paise > 0) return `+${text}`;
  return text;
}

/** Formats paise for an editable input: "1250" or "1250.50" (no symbol, no grouping). */
export function paiseToInputValue(paise: number): string {
  const { rupees, fraction } = splitPaise(paise);
  return fraction === 0 ? String(rupees) : `${rupees}.${String(fraction).padStart(2, '0')}`;
}

export type ParseAmountResult = { ok: true; paise: number } | { ok: false; error: string };

/**
 * Parses user input in rupees ("1,250.5", "₹ 500") into integer paise using
 * string handling only.
 */
export function parseRupeesToPaise(
  input: string,
  limits: { minPaise?: number; maxPaise?: number } = {},
): ParseAmountResult {
  const cleaned = input.trim().replace(/^₹/, '').replace(/[\s,]/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter an amount.' };
  const match = /^(\d{1,10})(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) {
    return { ok: false, error: 'Enter an amount in rupees, for example 500 or 1,250.50.' };
  }
  const rupees = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const paise = rupees * PAISE_PER_RUPEE + fraction;
  if (!Number.isSafeInteger(paise)) return { ok: false, error: 'That amount is too large.' };
  const min = limits.minPaise ?? MIN_TRANSFER_PAISE;
  const max = limits.maxPaise ?? MAX_TRANSFER_PAISE;
  if (paise < min) return { ok: false, error: `The minimum is ${formatINR(min)}.` };
  if (paise > max) return { ok: false, error: `The maximum is ${formatINR(max)}.` };
  return { ok: true, paise };
}

/** Integer percentage (0–100, floored) of progress toward a target. */
export function progressPercent(savedPaise: number, targetPaise: number): number {
  if (targetPaise <= 0 || savedPaise <= 0) return 0;
  if (savedPaise >= targetPaise) return 100;
  const scaled = savedPaise * 100;
  return (scaled - (scaled % targetPaise)) / targetPaise;
}

/** Integer ceiling division for non-negative integers. */
export function ceilDiv(numerator: number, denominator: number): number {
  const remainder = numerator % denominator;
  const quotient = (numerator - remainder) / denominator;
  return remainder === 0 ? quotient : quotient + 1;
}

const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function intDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const unit = n % 10;
  return TENS[intDiv(n, 10)]! + (unit ? `-${ONES[unit]}` : '');
}

function belowThousand(n: number): string {
  const hundreds = intDiv(n, 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/** Whole numbers in words using the Indian system (thousand, lakh, crore). */
export function numberInWordsIN(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('Expected a non-negative integer');
  if (n === 0) return 'zero';
  const crore = intDiv(n, 1_00_00_000);
  const lakh = intDiv(n % 1_00_00_000, 1_00_000);
  const thousand = intDiv(n % 1_00_000, 1_000);
  const rest = n % 1_000;
  const parts: string[] = [];
  if (crore) parts.push(`${numberInWordsIN(crore)} crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/** "Twelve thousand five hundred rupees and fifty paise" */
export function amountInWords(paise: number): string {
  if (!isPaise(paise)) throw new TypeError('Amount must be an integer number of paise');
  const { rupees, fraction } = splitPaise(paise);
  let text: string;
  if (rupees === 0 && fraction > 0) text = `${belowHundred(fraction)} paise`;
  else {
    text = `${numberInWordsIN(rupees)} ${rupees === 1 ? 'rupee' : 'rupees'}`;
    if (fraction) text += ` and ${belowHundred(fraction)} paise`;
  }
  if (paise < 0) text = `minus ${text}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
