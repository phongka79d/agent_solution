/**
 * @file Deterministic `format` checks (implement/05 §2 "JSON Schema / Type Guard").
 *
 * Every check here is local, clock-free and locale-free: no timezone database, no calendar library,
 * no `Date` parsing of a string whose shape was already rejected. A format the validator cannot
 * check this way is refused at registration instead of being accepted and then ignored.
 */

/** `YYYY-MM-DDThh:mm:ss(.sss)?(Z|±hh:mm)`, the RFC 3339 shape. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** `YYYY-MM-DD`. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `hh:mm:ss(.sss)?(Z|±hh:mm)`. */
const TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** The 8-4-4-4-12 hexadecimal shape. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A conservative `local@domain` shape; deliberately not an RFC 5322 parser. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Days in a month, honouring the Gregorian leap rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** Validates an already-captured calendar date. */
function isCalendarDate(year: string, month: string, day: string): boolean {
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  return (
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    dayNumber >= 1 &&
    dayNumber <= daysInMonth(Number(year), monthNumber)
  );
}

/** Validates an already-captured clock time; second 60 admits a leap second. */
function isClockTime(hour: string, minute: string, second: string): boolean {
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 60;
}

/**
 * Reports whether a string satisfies one supported format.
 *
 * @param format A format name from `SUPPORTED_FORMATS`.
 * @param value The string to check.
 * @returns `true` when the value satisfies the format.
 */
export function matchesFormat(format: string, value: string): boolean {
  switch (format) {
    case 'date-time': {
      const match = DATE_TIME.exec(value);
      return (
        match !== null &&
        isCalendarDate(match[1] ?? '', match[2] ?? '', match[3] ?? '') &&
        isClockTime(match[4] ?? '', match[5] ?? '', match[6] ?? '')
      );
    }
    case 'date': {
      const match = DATE.exec(value);
      return match !== null && isCalendarDate(match[1] ?? '', match[2] ?? '', match[3] ?? '');
    }
    case 'time': {
      const match = TIME.exec(value);
      return match !== null && isClockTime(match[1] ?? '', match[2] ?? '', match[3] ?? '');
    }
    case 'email':
      return EMAIL.test(value);
    case 'uuid':
      return UUID.test(value);
    case 'uri':
      try {
        // `new URL` accepts only an absolute URI, which is the check this format makes.
        return new URL(value).protocol.length > 1;
      } catch {
        return false;
      }
    default:
      return false;
  }
}
