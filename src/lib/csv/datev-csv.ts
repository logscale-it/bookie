/**
 * DATEV-Format Buchungsstapel (EXTF CSV) generator.
 *
 * Produces a posting batch the Steuerberater imports directly into DATEV
 * Kanzlei-Rechnungswesen (Stapelverarbeitung > ASCII-Import im DATEV-Format).
 * Format per DATEV spec "Buchungsstapel", header version 700, format
 * version 12: semicolon-separated, decimal comma, CRLF, ANSI (Windows-1252,
 * no BOM). Trailing empty fields may be omitted per spec, so rows carry only
 * the first 14 columns (through Buchungstext).
 */

export interface DatevBooking {
  /** Gross booking amount in cents; rows with 0 are skipped (DATEV rejects zero postings). */
  grossCents: number;
  /** Normalized VAT rate: 19, 7, or 0. Drives account + BU key selection. */
  taxRate: number;
  /** ISO date (yyyy-mm-dd); must lie within the export year. */
  date: string;
  /** Belegfeld 1 (invoice number). */
  documentNumber: string;
  /** Buchungstext (customer / supplier name). */
  text: string;
  kind: "revenue" | "expense";
}

export interface DatevExportOptions {
  /** DATEV Beraternummer, 1-7 digits. */
  consultantNumber: string;
  /** DATEV Mandantennummer, 1-5 digits. */
  clientNumber: string;
  skr: "03" | "04";
  year: number;
  generatedAt: Date;
}

// ponytail: fixed default accounts per SKR — revenue uses the Automatik-
// konten (VAT auto-derived, so no BU key), expenses book to the generic
// "Sonstige betriebliche Aufwendungen" with an explicit input-tax BU key.
// The Steuerberater can remap accounts during import; per-category expense
// accounts would need expense categories Bookie doesn't have.
const ACCOUNTS: Record<
  "03" | "04",
  {
    receivables: number;
    payables: number;
    expense: number;
    revenue: Record<number, number>;
  }
> = {
  "03": {
    receivables: 1400,
    payables: 1600,
    expense: 4900,
    revenue: { 19: 8400, 7: 8300, 0: 8120 },
  },
  "04": {
    receivables: 1200,
    payables: 3300,
    expense: 6300,
    revenue: { 19: 4400, 7: 4300, 0: 4120 },
  },
};

/** BU-Schlüssel for input tax on non-automatic expense accounts. */
const INPUT_TAX_BU: Record<number, string> = { 19: "9", 7: "8" };

/** Windows-1252 bytes for a JS string; unmappable chars become '?'. */
export function encodeCp1252(s: string): Uint8Array {
  // Chars where cp1252 differs from Latin-1 (the 0x80-0x9F block).
  const extra: Record<number, number> = {
    0x20ac: 0x80,
    0x201a: 0x82,
    0x0192: 0x83,
    0x201e: 0x84,
    0x2026: 0x85,
    0x2020: 0x86,
    0x2021: 0x87,
    0x02c6: 0x88,
    0x2030: 0x89,
    0x0160: 0x8a,
    0x2039: 0x8b,
    0x0152: 0x8c,
    0x017d: 0x8e,
    0x2018: 0x91,
    0x2019: 0x92,
    0x201c: 0x93,
    0x201d: 0x94,
    0x2022: 0x95,
    0x2013: 0x96,
    0x2014: 0x97,
    0x02dc: 0x98,
    0x2122: 0x99,
    0x0161: 0x9a,
    0x203a: 0x9b,
    0x0153: 0x9c,
    0x017e: 0x9e,
    0x0178: 0x9f,
  };
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out[i] = code;
    else out[i] = extra[code] ?? 0x3f; // '?'
  }
  return out;
}

function centsToDe(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function quote(s: string): string {
  return `"${s.replaceAll('"', "'")}"`;
}

/** Belegfeld 1 allows only digits, letters and $ % & * + - / per spec. */
function sanitizeDocumentNumber(s: string): string {
  return s.replace(/[^A-Za-z0-9$%&*+\-/]/g, "").slice(0, 36);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Belegdatum is TTMM (day + month, year comes from the header's WJ). */
function toBelegdatum(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}${month}`;
}

function buildHeader(opts: DatevExportOptions): string {
  const d = opts.generatedAt;
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}` +
    `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}` +
    `${pad(d.getMilliseconds(), 3)}`;
  const wjStart = `${opts.year}0101`;
  // 31 header fields per spec; unused/reserved ones stay empty.
  const fields = [
    quote("EXTF"), // 1 export marker (third-party origin)
    "700", // 2 header version
    "21", // 3 data category: Buchungsstapel
    quote("Buchungsstapel"), // 4 format name
    "12", // 5 format version
    ts, // 6 created at
    "", // 7 imported (reserved)
    quote("RE"), // 8 origin
    quote("Bookie"), // 9 exported by
    "", // 10 imported by
    opts.consultantNumber, // 11 Beraternummer
    opts.clientNumber, // 12 Mandantennummer
    wjStart, // 13 fiscal year start
    "4", // 14 G/L account number length
    wjStart, // 15 date from
    `${opts.year}1231`, // 16 date to
    quote(`Bookie ${opts.year}`), // 17 batch label
    "", // 18 dictation shorthand
    "1", // 19 posting type: Finanzbuchführung
    "0", // 20 accounting purpose
    "0", // 21 locked (Festschreibung)
    quote("EUR"), // 22 currency
    "", // 23 reserved
    "", // 24 derivative flag
    "", // 25 reserved
    "", // 26 reserved
    quote(opts.skr), // 27 chart of accounts
    "", // 28 industry solution id
    "", // 29 reserved
    "", // 30 reserved
    "", // 31 application info
  ];
  return fields.join(";");
}

const COLUMN_CAPTIONS = [
  "Umsatz (ohne Soll/Haben-Kz)",
  "Soll/Haben-Kennzeichen",
  "WKZ Umsatz",
  "Kurs",
  "Basis-Umsatz",
  "WKZ Basis-Umsatz",
  "Konto",
  "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel",
  "Belegdatum",
  "Belegfeld 1",
  "Belegfeld 2",
  "Skonto",
  "Buchungstext",
];

function buildBookingLine(
  b: DatevBooking,
  accounts: (typeof ACCOUNTS)["03"],
): string {
  // Revenue: debit receivables against the rate's Automatikkonto (no BU key
  // allowed on automatic accounts). Expense: credit payables against the
  // generic expense account with an explicit input-tax BU key.
  const isRevenue = b.kind === "revenue";
  const konto = isRevenue ? accounts.receivables : accounts.payables;
  const gegenkonto = isRevenue
    ? (accounts.revenue[b.taxRate] ?? accounts.revenue[0])
    : accounts.expense;
  const bu = isRevenue ? "" : (INPUT_TAX_BU[b.taxRate] ?? "");
  const fields = [
    centsToDe(b.grossCents), // 1 Umsatz
    quote(isRevenue ? "S" : "H"), // 2 Soll/Haben (side of Konto)
    quote("EUR"), // 3 WKZ
    "", // 4 Kurs
    "", // 5 Basis-Umsatz
    "", // 6 WKZ Basis-Umsatz
    String(konto), // 7 Konto
    String(gegenkonto), // 8 Gegenkonto
    bu ? quote(bu) : "", // 9 BU-Schlüssel
    toBelegdatum(b.date), // 10 Belegdatum TTMM
    quote(sanitizeDocumentNumber(b.documentNumber)), // 11 Belegfeld 1
    "", // 12 Belegfeld 2
    "", // 13 Skonto
    quote(b.text.slice(0, 60)), // 14 Buchungstext
  ];
  return fields.join(";");
}

/**
 * Build the complete EXTF file content. Encode with {@link encodeCp1252}
 * before writing — DATEV requires ANSI, not UTF-8.
 */
export function generateDatevBuchungsstapel(
  bookings: DatevBooking[],
  opts: DatevExportOptions,
): string {
  const accounts = ACCOUNTS[opts.skr];
  const lines = [buildHeader(opts), COLUMN_CAPTIONS.map(quote).join(";")];
  for (const b of bookings) {
    if (b.grossCents === 0) continue;
    lines.push(buildBookingLine(b, accounts));
  }
  return lines.join("\r\n") + "\r\n";
}
