import de from "./de";
import en from "./en";

const locales = { de, en } as const;

export type Locale = keyof typeof locales;
export type Translations = typeof de;

export const LOCALE_LABELS: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
};

let currentLocale: Locale = "de";

export function setLocale(l: Locale) {
  currentLocale = l;
}

export function getLocaleFormatting(): string {
  return currentLocale === "de" ? "de-DE" : "en-US";
}

/**
 * Get a translation by dot-separated key path.
 * Usage: t('nav.invoices') → 'Rechnungen'
 */
export function t(key: string): string {
  const keys = key.split(".");
  let val: unknown = locales[currentLocale];
  for (const k of keys) {
    if (val && typeof val === "object" && k in val) {
      val = (val as Record<string, unknown>)[k];
    } else {
      return key;
    }
  }
  return typeof val === "string" ? val : key;
}

/**
 * Get a translation with placeholder replacement.
 * Usage: tp('pdf.payableBefore', { date: '01.01.2026' })
 */
export function tp(
  key: string,
  params: Record<string, string | number>,
): string {
  let result = t(key);
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(`{${k}}`, () => String(v)); // function: no `$&` patterns in user text
  }
  return result;
}

/**
 * Get the full translations object for the current locale.
 * Useful when you need multiple values from the same section.
 */
export function translations(): Translations {
  return locales[currentLocale] as Translations;
}

/**
 * Get translations for a specific locale (e.g. for PDF generation in a different language).
 */
export function translationsFor(locale: Locale): Translations {
  return locales[locale] as Translations;
}
