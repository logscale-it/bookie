import { getLegalProfile, type LegalCountry } from "$lib/legal";

/**
 * COMP-1.a (#90): GoBD-aligned retention guard.
 *
 * §147 AO requires booking-relevant records (invoices, payments, audit rows)
 * to be retained for 10 years. The legal profile carries the per-country
 * retention window (`retentionYears`); destructive operations that would
 * remove a row whose `created_at` is still inside that window must be
 * rejected before they reach SQLite.
 *
 * Pattern mirrors `InvoiceImmutable` (DAT-2.b): a plain `Error` whose
 * `name` is the discriminator the UI branches on. Will be replaced with
 * the typed `BookieError.RetentionViolation` once OBS-2.c (#73) lands; until
 * then we keep the TS-side error structural so callers don't need to import
 * a class that is about to move.
 */
export function retentionViolationError(message: string): Error {
  const err = new Error(message);
  err.name = "RetentionViolation";
  return err;
}

/**
 * Best-effort country resolution for the guard. The guard intentionally
 * defaults to `'DE'` because the GoBD baseline is the strictest jurisdiction
 * we ship with — falling back to a shorter window would be unsafe.
 */
function resolveCountry(countryCode: string | null | undefined): LegalCountry {
  const allowed: LegalCountry[] = ["DE", "AT", "CH", "FR", "NL", "US"];
  if (countryCode && (allowed as string[]).includes(countryCode)) {
    return countryCode as LegalCountry;
  }
  return "DE";
}

/**
 * Returns true if `createdAt` is still inside the retention window for the
 * given country (i.e. a destructive op MUST be refused).
 *
 * `createdAt` is the SQLite `CURRENT_TIMESTAMP` string ('YYYY-MM-DD HH:MM:SS')
 * from the row's `created_at` column. `now` defaults to `new Date()` and is
 * a parameter so tests can pin it.
 */
export function isWithinRetention(
  countryCode: string | null | undefined,
  createdAt: string,
  now: Date = new Date(),
): boolean {
  const profile = getLegalProfile(resolveCountry(countryCode));
  const created = parseSqliteTimestamp(createdAt);
  if (created === null) {
    // A malformed timestamp is treated as "still within retention" — the
    // safe default for a guard is to refuse rather than silently allow.
    return true;
  }
  const ageMs = now.getTime() - created.getTime();
  // Use 365.25 days/year to absorb leap years over the 10-year window so
  // a row created exactly N retention years ago is treated as on-or-past
  // the boundary regardless of which calendar quarter we are in.
  const retentionMs = profile.retentionYears * 365.25 * 24 * 60 * 60 * 1000;
  return ageMs < retentionMs;
}

/**
 * Throws `RetentionViolation` if `createdAt` is still inside the retention
 * window. No-op otherwise. `entityLabel` is included in the German error
 * message so the UI can surface it without string surgery.
 */
export function assertOutsideRetention(
  entityLabel: string,
  countryCode: string | null | undefined,
  createdAt: string,
  now: Date = new Date(),
): void {
  if (isWithinRetention(countryCode, createdAt, now)) {
    const profile = getLegalProfile(resolveCountry(countryCode));
    throw retentionViolationError(
      `${entityLabel} darf nicht gelöscht werden — gesetzliche Aufbewahrungsfrist von ${profile.retentionYears} Jahren ist noch nicht abgelaufen`,
    );
  }
}

/**
 * Parse a SQLite `CURRENT_TIMESTAMP` value ('YYYY-MM-DD HH:MM:SS', UTC).
 * Returns `null` if the string is not a recognized timestamp shape so the
 * caller can fail closed.
 */
function parseSqliteTimestamp(s: string): Date | null {
  if (typeof s !== "string" || s.length === 0) return null;
  // Accept either ' ' or 'T' as the date/time separator and an optional 'Z'
  // — covers both SQLite's space form and any ISO-8601 string the caller
  // may already have normalized.
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}
