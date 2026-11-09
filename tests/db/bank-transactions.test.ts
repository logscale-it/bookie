import { test, expect } from "bun:test";
import * as companies from "../../src/lib/db/companies";
import { importBankTransactions } from "../../src/lib/db/bank-transactions";
import { getDatevBookingRows } from "../../src/lib/db/datev";
import { parseBankCsv } from "../../src/lib/csv/bank-csv";
import { generateDatevBuchungsstapel } from "../../src/lib/csv/datev-csv";
import { testDb } from "./setup";

// N26 layout; identical Hauptkonto rows are two real transfers.
const CSV = `"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"
2026-01-20,2026-01-20,"Kunde GmbH",DE89370400440532013000,"Credit Transfer","Rechnung RE-1",Geschäftskonto,119.00,,,
2026-01-20,2026-01-20,"Kunde GmbH",DE89370400440532013000,"Credit Transfer","Rechnung RE-2, Teilzahlung",Geschäftskonto,119.00,,,
2026-06-03,2026-06-03,Hauptkonto,,"Debit Transfer",,Geschäftskonto,-400.00,,,
2026-06-03,2026-06-03,Hauptkonto,,"Debit Transfer",,Geschäftskonto,-400.00,,,
2026-06-05,2026-06-05,"Rücklagen",,"Debit Transfer",,Geschäftskonto,-300.00,,,
2026-06-06,2026-06-06,Hauptkonto,,"Credit Transfer",,Geschäftskonto,20.00,,,
2026-05-01,2026-04-30,"Software Inc",,Presentment,,Geschäftskonto,-9.00,10,USD,0.9
2025-12-30,2025-12-30,"Alt",DE1,"Credit Transfer",x,Geschäftskonto,1,,,
`;

async function company() {
  return companies.createCompany({
    name: "Co", legal_name: null, street: null, postal_code: null, city: null, country_code: "DE",
    tax_number: null, vat_id: null, bank_account_holder: null, bank_iban: null, bank_bic: null, bank_name: null,
  });
}

test("parseBankCsv: signed cents, quoted commas, identical rows get distinct keys", () => {
  const r = parseBankCsv(CSV);
  expect(r.map((x) => x.amount_cents)).toEqual([11900, 11900, -40000, -40000, -30000, 2000, -900, 100]);
  expect(r[1].reference).toBe("Rechnung RE-2, Teilzahlung");
  expect(r[2].partner_iban).toBeNull();
  expect(r[2].import_key).not.toBe(r[3].import_key);
  expect(new Set(r.map((x) => x.import_key)).size).toBe(8);
  expect(() => parseBankCsv("a,b\n1,2")).toThrow(/CSV-Spalten fehlen/);
  expect(() => parseBankCsv(CSV.replace("119.00", "1,0x"))).toThrow(/Ungültige Zeile 2/);
});

test("import twice: second run only duplicates; overlapping export adds only new rows", async () => {
  const id = await company();
  expect(await importBankTransactions(id, parseBankCsv(CSV))).toEqual({ imported: 8, duplicates: 0 });
  expect(await importBankTransactions(id, parseBankCsv(CSV))).toEqual({ imported: 0, duplicates: 8 });
  const more = CSV + `2026-07-01,2026-07-01,Hauptkonto,,"Debit Transfer",,Geschäftskonto,-400.00,,,\n`;
  expect(await importBankTransactions(id, parseBankCsv(more))).toEqual({ imported: 1, duplicates: 8 });
});

test("DATEV: Space moves not booked unless the partner is a private account", async () => {
  const id = await company();
  await importBankTransactions(id, parseBankCsv(CSV));
  // No private accounts: Hauptkonto + Rücklagen are Space moves; 2025 row out of year.
  expect((await getDatevBookingRows(id, 2026)).map((b) => b.text)).toEqual([
    "Kunde GmbH Rechnung RE-1", "Kunde GmbH Rechnung RE-2, Teilzahlung", "Software Inc",
  ]);
});

test("DATEV: inflow S Bank an Forderungen, outflow H, private account as Privatentnahme / -einlage", async () => {
  const id = await company();
  testDb.raw.run("INSERT INTO settings_organization (id, name, datev_private_accounts) VALUES (1, 'Co', ' hauptkonto ,Sparkonto')");
  await importBankTransactions(id, parseBankCsv(CSV));
  const bookings = await getDatevBookingRows(id, 2026);
  expect(bookings).toHaveLength(6); // Rücklagen skipped, 2025 row excluded
  const opts = { consultantNumber: "1001", clientNumber: "10001", year: 2026, generatedAt: new Date() };
  const l03 = generateDatevBuchungsstapel(bookings, { ...opts, skr: "03" }).split("\r\n");
  expect(l03[2]).toBe('119,00;"S";"EUR";;;;1200;1400;;2001;"";;;"Kunde GmbH Rechnung RE-1"');
  expect(l03[5]).toBe('400,00;"H";"EUR";;;;1200;1800;;0306;"";;;"Hauptkonto"');
  expect(l03[6]).toBe(l03[5]);
  expect(l03[7]).toBe('20,00;"S";"EUR";;;;1200;1890;;0606;"";;;"Hauptkonto"');
  expect(l03[4]).toBe('9,00;"H";"EUR";;;;1200;1600;;0105;"";;;"Software Inc"');
  const l04 = generateDatevBuchungsstapel(bookings, { ...opts, skr: "04" }).split("\r\n");
  expect(l04[2]).toContain(";1800;1200;");
  expect(l04[5]).toContain(";1800;2100;");
  expect(l04[7]).toContain(";1800;2180;");
  expect(l04[4]).toContain(";1800;3300;");
});
