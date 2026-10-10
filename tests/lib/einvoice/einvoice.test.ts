/// <reference types="bun" />
// Fixtures in tests/fixtures/einvoice are HAND-WRITTEN (structure modelled on
// public samples); they are not official KoSIT/FNFE samples and this suite is
// not a substitute for the KoSIT validator.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, AFRelationship } from "pdf-lib";

import {
  parseEInvoiceXml,
  readEInvoice,
  toCents,
  EInvoiceParseError,
} from "../../../src/lib/einvoice";
import { renderInvoiceXml } from "../../../src/lib/pdf/invoice-xml";
import type { InvoiceXmlData } from "../../../src/lib/pdf/invoice-xml";

const fx = (n: string) => readFileSync(join(import.meta.dir, "../../fixtures/einvoice", n));
const text = (n: string) => fx(n).toString("utf8");

test("toCents is exact", () => {
  expect(toCents("19.99")).toBe(1999);
  expect(toCents("0.1")).toBe(10);
  expect(toCents("1.005")).toBe(101);
  expect(toCents("-5")).toBe(-500);
  expect(toCents(undefined)).toBe(0);
  expect(toCents("abc")).toBe(0);
});

test("UBL: header, parties, lines, taxes, totals", () => {
  const inv = parseEInvoiceXml(text("ubl-invoice.xml"));
  expect(inv.syntax).toBe("ubl");
  expect(inv.profile).toContain("xrechnung_3.0");
  expect(inv.number).toBe("RE-2026-0042");
  expect(inv.issueDate).toBe("2026-03-15");
  expect(inv.dueDate).toBe("2026-04-14");
  expect(inv.currency).toBe("EUR");
  expect(inv.buyerReference).toBe("04011000-12345-34");
  expect(inv.note).toBe("Vielen Dank & beste Grüße");
  expect(inv.seller.name).toBe("Lieferant GmbH");
  expect(inv.seller.vatId).toBe("DE123456789");
  expect(inv.seller.taxNumber).toBe("22/333/44444");
  expect(inv.seller.email).toBe("rechnung@lieferant.example");
  expect(inv.seller.city).toBe("Hamburg");
  expect(inv.buyer.name).toBe("Kunde AG");
  expect(inv.lines).toHaveLength(2);
  expect(inv.lines[0]).toMatchObject({ id: "1", name: "Beratung", quantity: 2.5, unit: "HUR", unitPrice: 40, netCents: 10000, taxRate: 19 });
  expect(inv.taxes).toEqual([{ category: "S", rate: 19, basisCents: 15000, taxCents: 2850 }]);
  expect(inv.totals).toEqual({ netCents: 15000, taxCents: 2850, grossCents: 17850, payableCents: 17850 });
});

test("CII: header, parties, lines, taxes, totals", () => {
  const inv = parseEInvoiceXml(text("cii-invoice.xml"));
  expect(inv.syntax).toBe("cii");
  expect(inv.number).toBe("R-77");
  expect(inv.issueDate).toBe("2026-03-01");
  expect(inv.dueDate).toBe("2026-03-31");
  expect(inv.typeCode).toBe("380");
  expect(inv.buyerReference).toBe("991-01234-77");
  expect(inv.seller).toMatchObject({ name: "Cloud Dienste GmbH", vatId: "DE987654321", city: "Köln", postalCode: "50667" });
  expect(inv.buyer.name).toBe("Freiberuflerin Muster");
  expect(inv.lines[0]).toMatchObject({ name: "Hosting März", quantity: 3, unitPrice: 20, netCents: 6000, taxRate: 19 });
  expect(inv.taxes[0]).toMatchObject({ rate: 19, basisCents: 6000, taxCents: 1140 });
  expect(inv.totals).toEqual({ netCents: 6000, taxCents: 1140, grossCents: 7140, payableCents: 7140 });
});

test("UBL CreditNote is read with type 381", () => {
  const xml = text("ubl-invoice.xml")
    .replace(/<ubl:Invoice /, "<ubl:CreditNote ")
    .replace("</ubl:Invoice>", "</ubl:CreditNote>")
    .replace(/<cbc:InvoiceTypeCode>380<\/cbc:InvoiceTypeCode>/, "")
    .replace(/InvoiceLine/g, "CreditNoteLine")
    .replace(/InvoicedQuantity/g, "CreditedQuantity");
  const inv = parseEInvoiceXml(xml);
  expect(inv.typeCode).toBe("381");
  expect(inv.lines).toHaveLength(2);
});

test("our own emitter output is readable (CII round trip)", () => {
  const data: InvoiceXmlData = {
    invoiceNumber: "RE-1",
    issueDate: "2026-05-10",
    dueDate: "2026-06-09",
    currency: "EUR",
    buyerReference: "LW-1",
    seller: { name: "Ich & Co", street: "Str. 1", postalCode: "12345", city: "Berlin", countryCode: "DE", vatId: "DE123456789" },
    buyer: { name: "Kunde", street: "Weg 2", postalCode: "80331", city: "München", countryCode: "DE" },
    items: [{ position: 1, description: "Arbeit", quantity: 2, unit: "HUR", unitPriceNetCents: 12000, lineTotalNetCents: 24000, taxRate: 19 }],
    taxGroups: [{ rate: 19, netAmountCents: 24000, amountCents: 4560 }],
    totals: { netCents: 24000, taxCents: 4560, grossCents: 28560 },
  };
  const inv = parseEInvoiceXml(renderInvoiceXml(data, "xrechnung"));
  expect(inv.profile).toContain("xrechnung_3.0");
  expect(inv.number).toBe("RE-1");
  expect(inv.buyerReference).toBe("LW-1");
  expect(inv.seller.name).toBe("Ich & Co");
  expect(inv.dueDate).toBe("2026-06-09");
  expect(inv.totals.grossCents).toBe(28560);
});

test("readEInvoice: XML bytes, ZUGFeRD-style PDF, plain PDF, junk", async () => {
  expect((await readEInvoice(fx("cii-invoice.xml")))?.number).toBe("R-77");

  const hybrid = await PDFDocument.create();
  hybrid.addPage();
  await hybrid.attach(fx("cii-invoice.xml"), "factur-x.xml", {
    mimeType: "application/xml",
    afRelationship: AFRelationship.Alternative,
  });
  const hybridBytes = new Uint8Array(await hybrid.save({ useObjectStreams: false }));
  const before = hybridBytes.slice();
  expect((await readEInvoice(hybridBytes))?.number).toBe("R-77");
  expect(hybridBytes).toEqual(before); // input untouched

  const plain = await PDFDocument.create();
  plain.addPage();
  expect(await readEInvoice(new Uint8Array(await plain.save()))).toBeNull();

  expect(await readEInvoice(new Uint8Array([1, 2, 3, 4]))).toBeNull();
});

test("rejects foreign XML, broken XML and ENTITY declarations", () => {
  expect(() => parseEInvoiceXml("<foo/>")).toThrow(EInvoiceParseError);
  expect(() => parseEInvoiceXml("<a><b></a>")).toThrow(EInvoiceParseError);
  expect(() => parseEInvoiceXml('<!DOCTYPE x [<!ENTITY e "x">]><Invoice/>')).toThrow(EInvoiceParseError);
});
