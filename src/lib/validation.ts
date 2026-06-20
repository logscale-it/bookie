// Format/checksum validators for the bureaucratic identifiers Bookie collects.
// Pure functions, no I/O — unit-tested in tests/lib/validation.test.ts and used
// for inline form feedback.

/** Normalise an IBAN: strip spaces and uppercase. */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** Group an IBAN into blocks of four for display: DE89 3704 0044 0532 0130 00. */
export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Validate an IBAN by structure + ISO 7064 mod-97 checksum (the check the bank
 * itself runs). Returns false for empty input — callers decide whether empty
 * is acceptable.
 */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  // Move the first four chars to the end, then replace each letter with its
  // position-based number (A=10 … Z=35) and take the value mod 97.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) =>
    String(ch.charCodeAt(0) - 55),
  );
  // The number is too large for Number; reduce mod 97 digit-by-digit.
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/**
 * Validate a VAT identification number (USt-IdNr). Germany ("DE") is checked
 * strictly (DE + 9 digits); other EU members get a structural check
 * (2-letter country prefix + 2–12 alphanumerics). Whitespace is ignored.
 */
export function isValidVatId(raw: string, country = "DE"): boolean {
  const vat = raw.replace(/\s+/g, "").toUpperCase();
  if (country.toUpperCase() === "DE") return /^DE\d{9}$/.test(vat);
  return /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(vat);
}
