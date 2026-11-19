/**
 * Time helpers. The domain never reads the clock: callers pass timestamps in.
 *
 * - `IsoTimestamp`: UTC instant, exactly `YYYY-MM-DDTHH:mm:ss.sssZ`
 *   (3 fraction digits, the form `Date#toISOString` and the DB reads produce).
 * - `CalendarDate`: `YYYY-MM-DD`, a Kampala calendar date.
 *
 * Kampala is UTC+3 with no daylight saving, so conversions are a fixed offset.
 * Calendar maths uses integer day counts (no Date objects), so it can be
 * checked against a `Date.UTC` reference in tests.
 *
 * Supported years are 1970 to 9998, which keeps every derived value (Kampala
 * date, due date 12 months later) a 4-digit year.
 */
export type IsoTimestamp = string;
export type CalendarDate = string;

export const MIN_YEAR = 1970;
export const MAX_YEAR = 9998;
const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validYmd(y: number, m: number, d: number): boolean {
  return y >= MIN_YEAR && y <= MAX_YEAR && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's days_from_civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Inverse of daysFromCivil. */
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719_468;
  const era = Math.floor(zz / 146_097);
  const doe = zz - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function formatDate(y: number, m: number, d: number): CalendarDate {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** True only for the exact `YYYY-MM-DDTHH:mm:ss.sssZ` form with real date and time values. */
export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== "string") return false;
  const m = ISO_TIMESTAMP.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return validYmd(y, mo, d) && h <= 23 && mi <= 59 && s <= 59;
}

/** True only for a real `YYYY-MM-DD` date in the supported range. */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string") return false;
  const m = CALENDAR_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = m.slice(1, 4).map(Number) as [number, number, number];
  return validYmd(y, mo, d);
}

function assertTimestamp(ts: IsoTimestamp): RegExpExecArray {
  const m = isIsoTimestamp(ts) ? ISO_TIMESTAMP.exec(ts) : null;
  if (!m) throw new RangeError(`not an IsoTimestamp: ${String(ts)}`);
  return m;
}

function assertDate(date: CalendarDate): [number, number, number] {
  const m = isCalendarDate(date) ? CALENDAR_DATE.exec(date) : null;
  if (!m) throw new RangeError(`not a CalendarDate: ${String(date)}`);
  return m.slice(1, 4).map(Number) as [number, number, number];
}

/** Milliseconds since the Unix epoch. Throws on an invalid timestamp. */
export function toEpochMs(ts: IsoTimestamp): number {
  const m = assertTimestamp(ts);
  const [y, mo, d, h, mi, s, ms] = m.slice(1, 8).map(Number) as [
    number, number, number, number, number, number, number,
  ];
  return daysFromCivil(y, mo, d) * DAY_MS + ((h * 60 + mi) * 60 + s) * 1000 + ms;
}

/** Kampala calendar date of a UTC instant (e.g. 21:00 UTC is the next day). */
export function kampalaDate(ts: IsoTimestamp): CalendarDate {
  const local = toEpochMs(ts) + KAMPALA_OFFSET_MS;
  const [y, m, d] = civilFromDays(Math.floor(local / DAY_MS));
  return formatDate(y, m, d);
}

/** Kampala hour of day, 0 to 23. */
export function kampalaHour(ts: IsoTimestamp): number {
  const local = toEpochMs(ts) + KAMPALA_OFFSET_MS;
  return Math.floor((local % DAY_MS) / (60 * 60 * 1000));
}

/**
 * Adds whole calendar months, clamping the day to the target month's length
 * (31 Jan + 1 month = 28 Feb, or 29 Feb in a leap year). R10.10.
 */
export function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  if (!Number.isSafeInteger(months) || months < 0) {
    throw new RangeError("addCalendarMonths: months must be a non-negative integer");
  }
  const [y, m, d] = assertDate(date);
  const index = y * 12 + (m - 1) + months;
  const ty = Math.floor(index / 12);
  const tm = (index % 12) + 1;
  if (ty > MAX_YEAR + 1) throw new RangeError("addCalendarMonths: result out of range");
  return formatDate(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}

/**
 * Whole Kampala calendar days from `from` to `to` (negative if `to` is
 * earlier). Each argument may be a CalendarDate (already a Kampala date) or an
 * IsoTimestamp (converted with kampalaDate). Used for days overdue (R11.6).
 */
export function kampalaDaysBetween(from: CalendarDate | IsoTimestamp, to: CalendarDate | IsoTimestamp): number {
  const toDays = (v: string) => {
    const [y, m, d] = assertDate(isIsoTimestamp(v) ? kampalaDate(v) : v);
    return daysFromCivil(y, m, d);
  };
  return toDays(to) - toDays(from);
}
