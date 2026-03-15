import { formatDeCurrency, buildCsvString } from "./csv-writer";
import type { UstvaRow } from "$lib/db/tax-reports";

export function generateUstvaCsv(
  data: UstvaRow[],
  companyName: string,
  year: number,
  taxNumber: string,
): string {
  const meta: string[][] = [
    ["Umsatzsteuervoranmeldung"],
    ["Unternehmen", companyName],
    ["Steuernummer", taxNumber],
    ["Jahr", String(year)],
  ];

  const headers = [
    "Zeitraum",
    "Steuerpflichtige Einnahmen 19%",
    "USt 19%",
    "Steuerpflichtige Einnahmen 7%",
    "USt 7%",
    "Steuerfreie Einnahmen",
    "Vorsteuer (Eingangsrechnungen)",
    "USt-Zahllast",
  ];

  const rows: string[][] = data.map((r) => [
    r.period,
    formatDeCurrency(r.revenue19Net),
    formatDeCurrency(r.vat19),
    formatDeCurrency(r.revenue7Net),
    formatDeCurrency(r.vat7),
    formatDeCurrency(r.revenue0Net),
    formatDeCurrency(r.inputTaxVat),
    formatDeCurrency(r.vatPayable),
  ]);

  // Totals row
  const totals = data.reduce(
    (acc, r) => ({
      r19n: acc.r19n + r.revenue19Net,
      v19: acc.v19 + r.vat19,
      r7n: acc.r7n + r.revenue7Net,
      v7: acc.v7 + r.vat7,
      r0n: acc.r0n + r.revenue0Net,
      inV: acc.inV + r.inputTaxVat,
      pay: acc.pay + r.vatPayable,
    }),
    { r19n: 0, v19: 0, r7n: 0, v7: 0, r0n: 0, inV: 0, pay: 0 },
  );

  rows.push([
    "Gesamt",
    formatDeCurrency(totals.r19n),
    formatDeCurrency(totals.v19),
    formatDeCurrency(totals.r7n),
    formatDeCurrency(totals.v7),
    formatDeCurrency(totals.r0n),
    formatDeCurrency(totals.inV),
    formatDeCurrency(totals.pay),
  ]);

  return buildCsvString(headers, rows, meta);
}
