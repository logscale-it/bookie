import { test, expect, describe } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { createEuerPdf } from "../../../src/lib/pdf/euer-pdf";
import type { EuerReport } from "../../../src/lib/db/tax-reports";

const report: EuerReport = {
  from: "2026-01-01",
  to: "2026-12-31",
  incomeTaxableNet: 100,
  incomeVat: 19,
  incomeTaxFreeNet: 50,
  incomeTotal: 169,
  expenseNet: 40,
  expenseVat: 7.6,
  expenseTotal: 47.6,
  vatPayable: 11.4,
  profit: 110,
};

const opts = {
  companyName: "Test GmbH",
  taxNumber: "12/345/67890",
  createdAt: new Date("2026-07-19T12:00:00Z"),
};

describe("createEuerPdf", () => {
  test("produces a one-page PDF with document metadata", async () => {
    const bytes = await createEuerPdf(report, opts);

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");

    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe(
      "Einnahmenüberschussrechnung 01.01.2026 bis 31.12.2026",
    );
    expect(doc.getSubject()).toBe(
      "Einnahmenüberschussrechnung nach § 4 Abs. 3 EStG",
    );
    expect(doc.getAuthor()).toBe("Test GmbH");
    expect(doc.getCreator()).toBe("Bookie");
    expect(doc.getProducer()).toBe("Bookie (pdf-lib)");
    expect(doc.getKeywords()).toContain("Einnahmenüberschussrechnung");
    expect(doc.getCreationDate()?.toISOString()).toBe(
      "2026-07-19T12:00:00.000Z",
    );
  });

  test("negative profit renders without throwing", async () => {
    const bytes = await createEuerPdf(
      { ...report, profit: -10.5, incomeTotal: 37.1 },
      opts,
    );
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
