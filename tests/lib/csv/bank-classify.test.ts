import { expect, test } from "bun:test";
import { parseBankCsv, privateNames, undecidedPartners } from "$lib/csv/bank-csv";
import { bankBooking } from "$lib/db/datev";

const CSV = `"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)"
2026-01-20,2026-01-20,Hauptkonto,,"Debit Transfer",,K,-72.00
2026-01-21,2026-01-21,Hauptkonto,,"Debit Transfer",,K,-50.00
2026-01-22,2026-01-22,"Steuer Rücklage",,"Debit Transfer",,K,-500.00
2026-01-23,2026-01-23,"Kunde",DE89370400440532013000,"Credit Transfer",R1,K,119.00
2026-01-24,2026-01-24,"Karte, Inc",,Presentment,,K,-9.00
2026-01-25,2026-01-25,"Name, mit Komma",,"Debit Transfer",,K,-1.00
`;

test("undecided partners: IBAN-less transfers only, grouped, sorted, minus the decided ones", () => {
  const rows = parseBankCsv(CSV);
  expect(undecidedPartners(rows, "", [])).toEqual([
    { name: "Hauptkonto", count: 2, sumCents: -12200 },
    { name: "Steuer Rücklage", count: 1, sumCents: -50000 },
  ]); // IBAN row, card payment and the comma name never show up
  expect(undecidedPartners(rows, "hauptkonto", []).map((p) => p.name)).toEqual(["Steuer Rücklage"]); // case-insensitive
  expect(undecidedPartners(rows, "", ["steuer rücklage"]).map((p) => p.name)).toEqual(["Hauptkonto"]);
  expect(undecidedPartners(rows, "Hauptkonto", ["steuer rücklage"])).toEqual([]);
  expect(privateNames(" A , b ,,")).toEqual(["a", "b"]);
});

test("the question and the export agree: classified private is booked, the rest of the IBAN-less transfers is not", () => {
  const rows = parseBankCsv(CSV);
  const booked = (priv: string) => rows.map((r) => bankBooking({ ...r, reference: r.reference }, priv)).filter(Boolean);
  expect(booked("")).toHaveLength(2); // only the IBAN transfer and the card payment; every IBAN-less transfer is skipped
  expect(booked("Hauptkonto").filter((b) => b!.private)).toHaveLength(2);
});
