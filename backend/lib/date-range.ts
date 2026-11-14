/**
 * UTC calendar-day date ranges for dashboards (shared by the admin control
 * center and business insights). Inputs are `YYYY-MM-DD`; invalid or reversed
 * input falls back to the default and ranges are capped.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 366;

export interface DateRange {
  from: Date;
  /** Exclusive end (start of the day after `to`). */
  to: Date;
  days: number;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * `from`/`to` as `YYYY-MM-DD` (UTC, inclusive). Defaults to the last 30 days.
 * Invalid or reversed values fall back to the default; ranges are capped.
 */
export function parseDateRange(fromRaw?: string | null, toRaw?: string | null, now = new Date()): DateRange {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const today = startOfUtcDay(now);
  let to = toRaw && iso.test(toRaw) ? new Date(`${toRaw}T00:00:00.000Z`) : today;
  let from = fromRaw && iso.test(fromRaw) ? new Date(`${fromRaw}T00:00:00.000Z`) : new Date(to.getTime() - 29 * DAY_MS);
  if (Number.isNaN(to.getTime())) to = today;
  if (Number.isNaN(from.getTime()) || from > to) from = new Date(to.getTime() - 29 * DAY_MS);
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    from = new Date(to.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS);
  }
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  return { from, to: new Date(to.getTime() + DAY_MS), days };
}

export function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

