import { formatDeCurrency, buildCsvString } from "./csv-writer";
import type { EuerRow } from "$lib/db/tax-reports";

export function generateEuerCsv(
  data: EuerRow[],
  companyName: string,
  year: number,
  taxNumber: string,
): string {
  const meta: string[][] = [
    ["Einnahmenüberschussrechnung (EÜR)"],
    ["Unternehmen", companyName],
    ["Steuernummer", taxNumber],
    ["Jahr", String(year)],
  ];

  const headers = [
    "Zeitraum",
    "Einnahmen (netto)",
    "USt auf Einnahmen",
    "Einnahmen (brutto)",
    "Ausgaben (netto)",
    "Vorsteuer auf Ausgaben",
    "Ausgaben (brutto)",
    "Gewinn/Verlust",
  ];

  const rows: string[][] = data.map((r) => [
    r.period,
    formatDeCurrency(r.incomeNet),
    formatDeCurrency(r.incomeTax),
    formatDeCurrency(r.incomeGross),
    formatDeCurrency(r.expenseNet),
    formatDeCurrency(r.expenseTax),
    formatDeCurrency(r.expenseGross),
    formatDeCurrency(r.profit),
  ]);

  // Totals row
  const totals = data.reduce(
    (acc, r) => ({
      iN: acc.iN + r.incomeNet,
      iT: acc.iT + r.incomeTax,
      iG: acc.iG + r.incomeGross,
      eN: acc.eN + r.expenseNet,
      eT: acc.eT + r.expenseTax,
      eG: acc.eG + r.expenseGross,
      p: acc.p + r.profit,
    }),
    { iN: 0, iT: 0, iG: 0, eN: 0, eT: 0, eG: 0, p: 0 },
  );

  rows.push([
    "Gesamt",
    formatDeCurrency(totals.iN),
    formatDeCurrency(totals.iT),
    formatDeCurrency(totals.iG),
    formatDeCurrency(totals.eN),
    formatDeCurrency(totals.eT),
    formatDeCurrency(totals.eG),
    formatDeCurrency(totals.p),
  ]);

  return buildCsvString(headers, rows, meta);
}
