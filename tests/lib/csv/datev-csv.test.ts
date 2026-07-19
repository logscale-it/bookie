import { test, expect, describe } from "bun:test";
import {
  generateDatevBuchungsstapel,
  encodeCp1252,
  type DatevBooking,
  type DatevExportOptions,
} from "../../../src/lib/csv/datev-csv";

const OPTS: DatevExportOptions = {
  consultantNumber: "1001",
  clientNumber: "10001",
  skr: "03",
  year: 2026,
  generatedAt: new Date(2026, 6, 15, 12, 30, 45, 123),
};

function revenue(overrides: Partial<DatevBooking> = {}): DatevBooking {
  return {
    grossCents: 119000,
    taxRate: 19,
    date: "2026-03-05",
    documentNumber: "RE-2026-001",
    text: "Kunde GmbH",
    kind: "revenue",
    ...overrides,
  };
}

function lines(csv: string): string[] {
  return csv.split("\r\n");
}

describe("DATEV Buchungsstapel generator", () => {
  test("EXTF header carries format, consultant/client, fiscal year and SKR", () => {
    const header = lines(generateDatevBuchungsstapel([], OPTS))[0];
    expect(header.startsWith('"EXTF";700;21;"Buchungsstapel";12;')).toBe(true);
    const fields = header.split(";");
    expect(fields[5]).toBe("20260715123045123"); // created-at timestamp
    expect(fields[10]).toBe("1001"); // Beraternummer
    expect(fields[11]).toBe("10001"); // Mandantennummer
    expect(fields[12]).toBe("20260101"); // WJ start
    expect(fields[14]).toBe("20260101"); // date from
    expect(fields[15]).toBe("20261231"); // date to
    expect(fields[26]).toBe('"03"'); // SKR
    expect(fields).toHaveLength(31);
  });

  test("second line is the column caption row", () => {
    const captions = lines(generateDatevBuchungsstapel([], OPTS))[1];
    expect(captions.startsWith('"Umsatz (ohne Soll/Haben-Kz)";')).toBe(true);
    expect(captions.split(";")).toHaveLength(14);
    expect(captions.endsWith('"Buchungstext"')).toBe(true);
  });

  test("revenue books receivables (S) against the rate's Automatikkonto without BU key", () => {
    const row = lines(generateDatevBuchungsstapel([revenue()], OPTS))[2];
    expect(row).toBe(
      '1190,00;"S";"EUR";;;;1400;8400;;0503;"RE-2026-001";;;"Kunde GmbH"',
    );
  });

  test("7% and 0% revenue map to 8300 / 8120 in SKR03", () => {
    const csv = generateDatevBuchungsstapel(
      [
        revenue({ taxRate: 7, grossCents: 10700 }),
        revenue({ taxRate: 0, grossCents: 10000 }),
      ],
      OPTS,
    );
    expect(lines(csv)[2]).toContain(";1400;8300;;");
    expect(lines(csv)[3]).toContain(";1400;8120;;");
  });

  test("expense books payables (H) against expense account with input-tax BU key", () => {
    const row = lines(
      generateDatevBuchungsstapel(
        [
          revenue({
            kind: "expense",
            grossCents: 5950,
            taxRate: 19,
            documentNumber: "IN-77",
            text: "Lieferant AG",
            date: "2026-11-30",
          }),
        ],
        OPTS,
      ),
    )[2];
    expect(row).toBe(
      '59,50;"H";"EUR";;;;1600;4900;"9";3011;"IN-77";;;"Lieferant AG"',
    );
  });

  test("7% expense uses BU 8, 0% expense has no BU key", () => {
    const csv = generateDatevBuchungsstapel(
      [
        revenue({ kind: "expense", taxRate: 7 }),
        revenue({ kind: "expense", taxRate: 0 }),
      ],
      OPTS,
    );
    expect(lines(csv)[2]).toContain(';1600;4900;"8";');
    expect(lines(csv)[3]).toContain(";1600;4900;;");
  });

  test("SKR04 maps to 1200/4400 and 3300/6300", () => {
    const csv = generateDatevBuchungsstapel(
      [revenue(), revenue({ kind: "expense" })],
      { ...OPTS, skr: "04" },
    );
    expect(lines(csv)[0].split(";")[26]).toBe('"04"');
    expect(lines(csv)[2]).toContain(";1200;4400;;");
    expect(lines(csv)[3]).toContain(';3300;6300;"9";');
  });

  test("zero-amount bookings are skipped (DATEV rejects zero postings)", () => {
    const csv = generateDatevBuchungsstapel([revenue({ grossCents: 0 })], OPTS);
    expect(lines(csv).filter((l) => l !== "")).toHaveLength(2);
  });

  test("Belegfeld 1 is sanitized to the DATEV character set, Buchungstext truncated to 60", () => {
    const row = lines(
      generateDatevBuchungsstapel(
        [
          revenue({
            documentNumber: 'RE 2026 #001 "x"',
            text: `"${"a".repeat(80)}"`,
          }),
        ],
        OPTS,
      ),
    )[2];
    expect(row).toContain('"RE2026001x"');
    // quotes are replaced, text capped at 60 chars inside the quotes
    expect(row.endsWith(`;"'${"a".repeat(59)}"`)).toBe(true);
  });

  test("file uses CRLF, ends with trailing newline, and has no BOM", () => {
    const csv = generateDatevBuchungsstapel([revenue()], OPTS);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(4); // header, captions, row, ""
  });
});

describe("encodeCp1252", () => {
  test("maps ASCII, Latin-1 umlauts and the euro sign", () => {
    const bytes = encodeCp1252("A;ä€ß");
    expect([...bytes]).toEqual([0x41, 0x3b, 0xe4, 0x80, 0xdf]);
  });

  test("unmappable characters become '?'", () => {
    expect([...encodeCp1252("Č中")]).toEqual([0x3f, 0x3f]);
  });
});
