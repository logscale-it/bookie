import { describe, expect, test } from "bun:test";

import {
  fmtNumber,
  generateInvoiceHtml,
  type InvoicePdfData,
} from "../../../src/lib/pdf/invoice-pdf";
import { formatCents } from "../../../src/lib/shared/money";

function makeInvoice(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    issuerName: "Example GmbH",
    issuerAddress: "Example Street 1, Berlin, DE",
    issuerTaxNumber: "12/345/67890",
    issuerVatId: "DE123456789",
    issuerBankAccountHolder: "Example GmbH",
    issuerBankName: "Example Bank",
    issuerBankIban: "",
    issuerBankBic: "",
    issuerEmail: "hello@example.test",
    issuerWebsite: "",
    issuerPhone: "",
    logoDataUrl: null,
    recipientName: "Customer GmbH",
    recipientAddress: "Customer Street 2, Berlin, DE",
    invoiceNumber: "INV-TEST-001",
    issueDate: "2026-01-10",
    dueDate: "2026-02-10",
    deliveryDate: "2026-01-10",
    overdueCharge: 0,
    servicePeriodStart: "",
    servicePeriodEnd: "",
    currency: "EUR",
    notes: "",
    language: "de",
    legalCountry: "DE",
    items: [
      {
        position: 1,
        description: "Consulting",
        quantity: 1,
        unit: "h",
        unitPriceNetCents: 10000,
        taxRate: 19,
        lineTotalNetCents: 10000,
      },
    ],
    subtotalCents: 10000,
    taxGroups: [
      { label: "VAT 19%", rate: 19, netAmountCents: 10000, amountCents: 1900 },
    ],
    totalCents: 11900,
    ...overrides,
  };
}

describe("generateInvoiceHtml invoice totals", () => {
  test.each([
    { rate: 0, netCents: 10000, vatCents: 0, grossCents: 10000 },
    { rate: 7, netCents: 10000, vatCents: 700, grossCents: 10700 },
    { rate: 19, netCents: 10000, vatCents: 1900, grossCents: 11900 },
  ])(
    "renders net, VAT and gross amounts for $rate% VAT",
    ({ rate, netCents, vatCents, grossCents }) => {
      const html = generateInvoiceHtml(
        makeInvoice({
          items: [
            {
              position: 1,
              description: "Service",
              quantity: 1,
              unit: "item",
              unitPriceNetCents: netCents,
              taxRate: rate,
              lineTotalNetCents: netCents,
            },
          ],
          subtotalCents: netCents,
          taxGroups: [
            {
              label: `VAT ${rate}%`,
              rate,
              netAmountCents: netCents,
              amountCents: vatCents,
            },
          ],
          totalCents: grossCents,
        }),
      );

      expect(html).toContain(`${rate} %`);
      expect(html).toContain(formatCents(netCents, "de-DE", "EUR"));
      expect(html).toContain(formatCents(vatCents, "de-DE", "EUR"));
      expect(html).toContain(formatCents(grossCents, "de-DE", "EUR"));
    },
  );

  test("renders each line item and the provided subtotal, tax group and gross total", () => {
    const html = generateInvoiceHtml(
      makeInvoice({
        items: [
          {
            position: 1,
            description: "Design work",
            quantity: 2,
            unit: "h",
            unitPriceNetCents: 4500,
            taxRate: 7,
            lineTotalNetCents: 9000,
          },
          {
            position: 2,
            description: "Consulting",
            quantity: 1,
            unit: "h",
            unitPriceNetCents: 11000,
            taxRate: 19,
            lineTotalNetCents: 11000,
          },
        ],
        subtotalCents: 20000,
        taxGroups: [
          { label: "VAT 7%", rate: 7, netAmountCents: 9000, amountCents: 630 },
          {
            label: "VAT 19%",
            rate: 19,
            netAmountCents: 11000,
            amountCents: 2090,
          },
        ],
        totalCents: 22720,
      }),
    );

    expect(html).toContain("Design work");
    expect(html).toContain("Consulting");
    expect(html).toContain(formatCents(9000, "de-DE", "EUR"));
    expect(html).toContain(formatCents(11000, "de-DE", "EUR"));
    expect(html).toContain(formatCents(630, "de-DE", "EUR"));
    expect(html).toContain(formatCents(2090, "de-DE", "EUR"));
    expect(html).toContain(formatCents(22720, "de-DE", "EUR"));
  });

  test("formats cents and fractional cents consistently at the display boundary", () => {
    expect(formatCents(1, "de-DE", "EUR")).toBe(
      new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: "EUR",
      }).format(0.01),
    );
    expect(formatCents(100.4, "de-DE", "EUR")).toBe(
      formatCents(100, "de-DE", "EUR"),
    );
    expect(formatCents(100.5, "de-DE", "EUR")).toBe(
      formatCents(101, "de-DE", "EUR"),
    );
    expect(formatCents(Number.NaN, "de-DE", "EUR")).toBe(
      formatCents(0, "de-DE", "EUR"),
    );
  });
});

describe("invoice formatting helpers", () => {
  test("formats quantity values using the requested locale", () => {
    expect(fmtNumber(1234.5, "de-DE")).toBe("1.234,5");
    expect(fmtNumber(1234.5, "en-US")).toBe("1,234.5");
  });
});
