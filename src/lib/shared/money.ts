import { getLocaleFormatting } from "../i18n";

/**
 * Format an integer number of minor currency units (cents) as a localized
 * currency string.
 *
 * Money is stored as INTEGER cents in the database (see migration 0015).
 * Use this formatter at every UI display boundary so rounding, grouping and
 * the currency symbol are produced by `Intl.NumberFormat` rather than ad-hoc
 * string math.
 *
 * @param cents    Amount in minor currency units (e.g. 199 means 1.99).
 *                 Non-finite values are coerced to 0. Fractional inputs are
 *                 rounded to the nearest integer before formatting.
 * @param locale   BCP-47 locale tag. Defaults to the app's current locale
 *                 formatting (`de-DE` or `en-US`, see `src/lib/i18n`).
 * @param currency ISO 4217 currency code. Defaults to `EUR`.
 * @returns        Localized currency string, e.g. `"1,99 €"` or `"$1.99"`.
 */
export function formatCents(
  cents: number,
  locale?: string,
  currency: string = "EUR",
): string {
  const safeCents = Number.isFinite(cents) ? Math.round(cents) : 0;
  const value = safeCents / 100;
  const resolvedLocale = locale ?? getLocaleFormatting();
  return new Intl.NumberFormat(resolvedLocale, {
    style: "currency",
    currency,
  }).format(value);
}
