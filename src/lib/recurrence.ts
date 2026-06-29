// Pure date arithmetic for recurring schedules. All dates are ISO `YYYY-MM-DD`
// strings handled in UTC so they never drift across DST boundaries.

export type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

const MONTHS_PER: Record<Exclude<Frequency, "weekly">, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * Advance an ISO date by `count` periods of `freq`.
 *
 * Month/quarter/year steps clamp the day to the last valid day of the target
 * month, so e.g. Jan 31 + 1 month → Feb 28 (or Feb 29 in a leap year) rather
 * than spilling into March. Weekly steps are plain 7-day additions.
 */
export function advance(
  dateISO: string,
  freq: Frequency,
  count: number,
): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  if (freq === "weekly") {
    const ms = Date.UTC(y, m - 1, d) + count * 7 * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const totalMonths = m - 1 + count * MONTHS_PER[freq];
  const ty = y + Math.floor(totalMonths / 12);
  const tm = ((totalMonths % 12) + 12) % 12; // 0-based, always positive
  // Day 0 of month tm+1 is the last day of month tm — used to clamp overflow.
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const td = Math.min(d, lastDay);
  return new Date(Date.UTC(ty, tm, td)).toISOString().slice(0, 10);
}

/** Add `days` calendar days to an ISO date (UTC). */
export function addDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
