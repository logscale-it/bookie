import { expect, test } from "bun:test";
import { parseExtraction } from "$lib/ai";

test("parseExtraction reads fenced JSON and normalises amounts", () => {
  const text = 'Hier:\n```json\n{"supplier_name": " ACME GmbH ", "invoice_number": "R-1", "invoice_date": "2026-10-01", "net_amount": "1.234,50", "tax_amount": 234.555, "currency": "EUR"}\n```';
  expect(parseExtraction(text)).toEqual({
    supplierName: "ACME GmbH",
    invoiceNumber: "R-1",
    invoiceDate: "2026-10-01",
    netAmount: "1234.50",
    taxAmount: "234.56",
  });
});

test("parseExtraction drops invalid fields", () => {
  expect(
    parseExtraction('{"supplier_name": null, "invoice_date": "01.10.2026", "net_amount": "n/a", "tax_amount": 0}'),
  ).toEqual({ taxAmount: "0.00" });
});

test("parseExtraction rejects answers without JSON", () => {
  expect(() => parseExtraction("Ich kann das nicht lesen.")).toThrow();
});
