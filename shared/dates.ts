/**
 * Calendar helpers. Calendar dates are 'YYYY-MM-DD' strings interpreted in
 * India Standard Time; timestamps are ISO-8601 UTC strings.
 */

export const IST_TIME_ZONE = 'Asia/Kolkata';
export type ISODate = string;
export type Frequency = 'daily' | 'weekly' | 'monthly';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = toUTCDate(value);
  return !Number.isNaN(date.getTime()) && fromUTCDate(date) === value;
}

function toUTCDate(date: ISODate): Date {
  return new Date(`${date}T00:00:00Z`);
}

function fromUTCDate(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

const istDateParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar date in India for an instant. */
export function todayInIST(now: Date): ISODate {
  const parts = Object.fromEntries(istDateParts.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = toUTCDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTCDate(d);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function weekdayOf(date: ISODate): number {
  return toUTCDate(date).getUTCDay();
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

/** Day-of-month (monthly), weekday (weekly) or null (daily) that a schedule repeats on. */
export function anchorFor(frequency: Frequency, startDate: ISODate): number | null {
  if (frequency === 'monthly') return Number(startDate.slice(8, 10));
  if (frequency === 'weekly') return weekdayOf(startDate);
  return null;
}

function parts(date: ISODate): { y: number; m: number; d: number } {
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) };
}

function iso(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * First occurrence on or after `onOrAfter` (and never before `startDate`).
 * Monthly schedules keep their anchor day and clamp to the month's last day,
 * so a schedule started on the 31st runs on 30 Apr, 28/29 Feb, 31 May…
 */
export function occurrenceOnOrAfter(
  frequency: Frequency,
  anchor: number | null,
  startDate: ISODate,
  onOrAfter: ISODate,
): ISODate {
  const base = maxDate(startDate, onOrAfter);
  if (frequency === 'daily') return base;
  if (frequency === 'weekly') {
    const target = anchor ?? weekdayOf(startDate);
    return addDays(base, (target - weekdayOf(base) + 7) % 7);
  }
  const anchorDay = anchor ?? parts(startDate).d;
  const { y, m, d } = parts(base);
  const thisMonth = Math.min(anchorDay, daysInMonth(y, m));
  if (thisMonth >= d) return iso(y, m, thisMonth);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return iso(ny, nm, Math.min(anchorDay, daysInMonth(ny, nm)));
}

/** The occurrence strictly after `date`. */
export function occurrenceAfter(frequency: Frequency, anchor: number | null, startDate: ISODate, date: ISODate): ISODate {
  return occurrenceOnOrAfter(frequency, anchor, startDate, addDays(date, 1));
}

export function upcomingOccurrences(
  frequency: Frequency,
  anchor: number | null,
  startDate: ISODate,
  from: ISODate,
  count: number,
): ISODate[] {
  const result: ISODate[] = [];
  let next = occurrenceOnOrAfter(frequency, anchor, startDate, from);
  while (result.length < count) {
    result.push(next);
    next = occurrenceAfter(frequency, anchor, startDate, next);
  }
  return result;
}

/** Whole calendar months from `from` until `to`, counting a partial month as one (minimum 1). */
export function monthsUntil(from: ISODate, to: ISODate): number {
  const a = parts(from);
  const b = parts(to);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d > a.d) months += 1;
  return Math.max(1, months);
}

export function addMonths(date: ISODate, months: number): ISODate {
  const { y, m, d } = parts(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

const dateFormatter = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: IST_TIME_ZONE,
});
const timeFormatter = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: IST_TIME_ZONE,
});

/** "18 Oct 2026" */
export function formatDateIN(date: ISODate): string {
  return dateFormatter.format(toUTCDate(date));
}

/** "18 Oct 2026, 3:45 pm" (IST) */
export function formatDateTimeIN(timestamp: string): string {
  return dateTimeFormatter.format(new Date(timestamp));
}

/** "3:45 pm" (IST) */
export function formatTimeIN(timestamp: string): string {
  return timeFormatter.format(new Date(timestamp));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** "every day", "every Monday", "every month on the 31st (or the month's last day)" */
export function describeFrequency(frequency: Frequency, anchor: number | null): string {
  if (frequency === 'daily') return 'every day';
  if (frequency === 'weekly') return `every ${WEEKDAYS[anchor ?? 0]}`;
  const day = anchor ?? 1;
  return day > 28 ? `every month on the ${ordinal(day)} (or the month's last day)` : `every month on the ${ordinal(day)}`;
}
