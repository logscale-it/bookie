/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Company, Customer, Invoice } from "../../../src/lib/db/types";
import type { InvoicePdfData } from "../../../src/lib/pdf/invoice-pdf";
import {
  renderInvoiceXml,
  toUnitCode,
  escapeXml,
} from "../../../src/lib/pdf/invoice-xml";
import { buildInvoiceXmlData } from "../../../src/lib/einvoice/build";
import {
  createEInvoice,
  EInvoiceValidationError,
} from "../../../src/lib/einvoice/export";
import {
  hasErrors,
  isValidIban,
  validateInvoiceXmlData,
} from "../../../src/lib/einvoice/validate";
import { describeIssue } from "../../../src/lib/einvoice/format";
import { readEInvoice } from "../../../src/lib/einvoice";

const pdf: InvoicePdfData = {
  issuerName: "Mustermann GmbH",
  issuerAddress: "Musterstr. 1, 12345 Berlin",
  issuerTaxNumber: "12/345/67890",
  issuerVatId: "DE 123456789",
  issuerBankAccountHolder: "Mustermann GmbH",
  issuerBankName: "Beispielbank",
  issuerBankIban: "DE89 3704 0044 0532 0130 00",
  issuerBankBic: "COBADEFFXXX",
  issuerEmail: "kontakt@mustermann.example",
  issuerWebsite: "",
  issuerPhone: "+49 30 1234567",
  logoDataUrl: null,
  recipientName: "Beispiel AG",
  recipientAddress: "Beispielweg 9, 80331 München",
  invoiceNumber: "RE-2026-001",
  issueDate: "2026-05-10",
  dueDate: "2026-06-09",
  deliveryDate: "2026-05-10",
  overdueCharge: 0,
  servicePeriodStart: "2026-04-01",
  servicePeriodEnd: "2026-04-30",
  currency: "EUR",
  notes: "",
  language: "de",
  legalCountry: "DE",
  items: [
    {
      position: 1,
      description: "Beratung",
      quantity: 2,
      unit: "Stk",
      unitPriceNetCents: 12000,
      taxRate: 19,
      lineTotalNetCents: 24000,
    },
  ],
  subtotalCents: 24000,
  taxGroups: [
    { label: "MwSt. 19 %", rate: 19, netAmountCents: 24000, amountCents: 4560 },
  ],
  totalCents: 28560,
};

const company = {
  street: "Musterstr. 1",
  postal_code: "12345",
  city: "Berlin",
  country_code: "DE",
} as Company;
const customer = {
  name: "Beispiel AG",
  street: "Beispielweg 9",
  postal_code: "80331",
  city: "München",
  country_code: "DE",
  vat_id: "DE 987654321",
  email: "einkauf@beispiel.example",
} as Customer;
const org = {
  street: "",
  postal_code: "",
  city: "",
  email: "kontakt@mustermann.example",
  phone_number: "+49 30 1234567",
  default_legal_country: "DE",
};

const xml = () =>
  buildInvoiceXmlData(pdf, {
    org,
    company,
    customer,
    buyerReference: "04011000-12345-34",
  });
const fields = (issues: ReturnType<typeof validateInvoiceXmlData>) =>
  issues.filter((i) => i.severity === "error").map((i) => i.field);

describe("buildInvoiceXmlData", () => {
  test("maps parties and totals, normalises VAT ID and IBAN", () => {
    const d = xml();
    expect(d.seller).toMatchObject({
      street: "Musterstr. 1",
      postalCode: "12345",
      city: "Berlin",
      countryCode: "DE",
      vatId: "DE123456789",
      bankIban: "DE89370400440532013000",
    });
    expect(d.buyer).toMatchObject({
      postalCode: "80331",
      vatId: "DE987654321",
      email: "einkauf@beispiel.example",
    });
    expect(d.totals).toEqual({
      netCents: 24000,
      taxCents: 4560,
      grossCents: 28560,
    });
  });

  test("issued invoice: frozen addresses win, empty ones fall back to live", () => {
    const snapshot = {
      issuer_street: "Neue Str. 2",
      issuer_postal_code: "50667",
      issuer_city: "Köln",
      issuer_country_code: "DE",
      recipient_street: null,
      recipient_postal_code: null,
      recipient_city: "Hamburg",
      recipient_country_code: null,
    } as Invoice;
    const d = buildInvoiceXmlData(pdf, { org, company, customer, snapshot });
    expect(d.seller).toMatchObject({ street: "Neue Str. 2", city: "Köln" });
    expect(d.buyer).toMatchObject({ street: "Beispielweg 9", city: "Hamburg" });
  });
});

describe("validateInvoiceXmlData", () => {
  test("complete invoice has no errors for either format", () => {
    expect(fields(validateInvoiceXmlData(xml(), "zugferd"))).toEqual([]);
    expect(fields(validateInvoiceXmlData(xml(), "xrechnung"))).toEqual([]);
  });

  test("seller needs a VAT ID or a tax number", () => {
    const d = xml();
    d.seller.vatId = undefined;
    expect(fields(validateInvoiceXmlData(d, "zugferd"))).toEqual([]); // tax number is enough
    d.seller.taxNumber = undefined;
    expect(fields(validateInvoiceXmlData(d, "zugferd"))).toContain(
      "seller.vatId",
    );
  });

  test("IBAN checksum", () => {
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(isValidIban("DE89370400440532013001")).toBe(false);
    const d = xml();
    d.seller.bankIban = "DE00370400440532013000";
    expect(fields(validateInvoiceXmlData(d, "zugferd"))).toContain(
      "seller.bankIban",
    );
  });

  test("totals and line sums must agree", () => {
    const d = xml();
    d.totals.grossCents += 5;
    d.items[0].lineTotalNetCents += 100;
    const f = fields(validateInvoiceXmlData(d, "zugferd"));
    expect(f).toContain("totals.gross");
    expect(f).toContain("items[0].lineTotal");
    expect(f).toContain("totals.net");
  });

  test("one cent of rounding is tolerated", () => {
    const d = xml();
    d.items[0].unitPriceNetCents = 11999; // 2 × 119.99 = 239.98 vs 240.00 is 2 cents
    expect(fields(validateInvoiceXmlData(d, "zugferd"))).toContain(
      "items[0].lineTotal",
    );
    d.items[0].lineTotalNetCents = 23999; // 1 cent off 239.98
    expect(fields(validateInvoiceXmlData(d, "zugferd"))).not.toContain(
      "items[0].lineTotal",
    );
  });

  test("XRechnung-only requirements do not block ZUGFeRD", () => {
    const d = xml();
    d.buyerReference = undefined;
    d.buyer.email = undefined;
    d.seller.phone = undefined;
    expect(fields(validateInvoiceXmlData(d, "zugferd"))).toEqual([]);
    expect(fields(validateInvoiceXmlData(d, "xrechnung"))).toEqual([
      "seller.phone",
      "buyer.email",
    ]);
  });

  test("rate used by a line without a tax group is reported", () => {
    const d = xml();
    d.items.push({
      position: 2,
      description: "Buch",
      quantity: 1,
      unit: "Stk",
      unitPriceNetCents: 1000,
      lineTotalNetCents: 1000,
      taxRate: 7,
    });
    expect(fields(validateInvoiceXmlData(d, "zugferd"))).toContain(
      "taxGroups.group",
    );
  });

  test("0 % is a warning (exported as exempt), not an error", () => {
    const d = xml();
    d.items[0].taxRate = 0;
    d.taxGroups = [{ rate: 0, netAmountCents: 24000, amountCents: 0 }];
    d.totals = { netCents: 24000, taxCents: 0, grossCents: 24000 };
    const issues = validateInvoiceXmlData(d, "zugferd");
    expect(hasErrors(issues)).toBe(false);
    expect(issues.some((i) => i.code === "unsupported")).toBe(true);
  });

  test("invalid and missing dates", () => {
    const d = xml();
    d.issueDate = "2026-02-30";
    d.dueDate = undefined;
    expect(fields(validateInvoiceXmlData(d, "zugferd"))).toEqual([
      "issueDate",
      "dueDate",
    ]);
  });

  test("describeIssue is readable and position-aware", () => {
    const d = xml();
    d.items[0].description = " ";
    const issue = validateInvoiceXmlData(d, "zugferd").find(
      (i) => i.field === "items[0].description",
    )!;
    expect(describeIssue(issue)).toBe("Position 1: Beschreibung fehlt (BR-25)");
  });

  test("an invalid VAT ID, IBAN or BIC says what a valid value looks like", () => {
    const d = xml();
    d.seller.vatId = "123";
    d.seller.bankIban = "DE89 3704 0044";
    d.seller.bankBic = "COBA";
    const issues = validateInvoiceXmlData(d, "zugferd");
    const text = (field: string) =>
      describeIssue(issues.find((i) => i.field === field)!);
    expect(text("seller.vatId")).toBe(
      "USt-IdNr. oder Steuernummer ist ungültig: erwartet wird ein Ländercode mit Nummer, z. B. DE123456789 (BR-CO-9)",
    );
    expect(text("seller.bankIban")).toBe(
      "IBAN des Rechnungsstellers (Unternehmen oder Einstellungen → Organisation) ist ungültig: Länge oder Prüfziffer stimmt nicht, bitte mit dem Kontoauszug vergleichen (BR-61)",
    );
    expect(text("seller.bankBic")).toBe(
      "BIC ist ungültig: erwartet werden 8 oder 11 Buchstaben und Ziffern, z. B. COBADEFFXXX (BT-86)",
    );
  });

  test("other invalid fields keep the short message", () => {
    const d = xml();
    d.currency = "euro";
    const issue = validateInvoiceXmlData(d, "zugferd").find(
      (i) => i.field === "currency",
    )!;
    expect(describeIssue(issue)).toBe("Währung ist ungültig (BR-5)");
  });
});

describe("renderInvoiceXml (EN 16931 additions)", () => {
  test("unit codes: free text → UN/ECE, valid codes pass through", () => {
    expect(toUnitCode("Stk")).toBe("C62");
    expect(toUnitCode("Std")).toBe("HUR");
    expect(toUnitCode("HUR")).toBe("HUR");
    expect(toUnitCode("")).toBe("C62");
    expect(toUnitCode("Lichtjahre")).toBe("C62");
  });

  test("emits contact, electronic addresses, payment reference and period", () => {
    const out = renderInvoiceXml(xml(), "zugferd");
    expect(out).toContain(
      '<ram:URIID schemeID="EM">einkauf@beispiel.example</ram:URIID>',
    );
    expect(out).toContain("<ram:EmailURIUniversalCommunication>");
    expect(out).toContain(
      "<ram:PaymentReference>RE-2026-001</ram:PaymentReference>",
    );
    expect(out).toContain("<ram:BillingSpecifiedPeriod>");
    expect(out).toContain(
      "<ram:BuyerReference>04011000-12345-34</ram:BuyerReference>",
    );
    expect(out).toContain('unitCode="C62"');
  });

  test("seller with only a tax number gets it as seller ID (BR-CO-26)", () => {
    const d = xml();
    d.seller.vatId = undefined;
    const out = renderInvoiceXml(d, "zugferd");
    expect(out).toContain("<ram:ID>12/345/67890</ram:ID>");
    expect(out).not.toContain('schemeID="VA">DE123456789');
  });

  test("0 % group is category E with an exemption reason", () => {
    const d = xml();
    d.items[0].taxRate = 0;
    d.taxGroups = [{ rate: 0, netAmountCents: 24000, amountCents: 0 }];
    const out = renderInvoiceXml(d, "zugferd");
    expect(out).toContain(
      "<ram:ExemptionReason>Umsatzsteuerfrei</ram:ExemptionReason>",
    );
    expect(out).toContain("<ram:CategoryCode>E</ram:CategoryCode>");
    expect(out).not.toContain("<ram:CategoryCode>S</ram:CategoryCode>");
  });

  test("control characters are stripped (XML 1.0)", () => {
    expect(escapeXml("a\u0000b\u0008c\u000bd\u001fe\tf")).toBe("abcde\tf");
  });
});

describe("createEInvoice", () => {
  test("ZUGFeRD: produces a PDF whose embedded XML reads back to the same invoice", async () => {
    const file = await createEInvoice(pdf, xml(), "zugferd");
    expect(file.extension).toBe("pdf");
    expect(new TextDecoder("latin1").decode(file.bytes.subarray(0, 5))).toBe(
      "%PDF-",
    );
    const back = await readEInvoice(file.bytes);
    expect(back?.number).toBe("RE-2026-001");
    expect(back?.totals.grossCents).toBe(28560);
    expect(back?.seller.vatId).toBe("DE123456789");
  });

  test("ZUGFeRD PDF is PDF/A-3 shaped: embedded fonts, ICC profile, trailer ID", async () => {
    const { bytes } = await createEInvoice(pdf, xml(), "zugferd");
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("/FontFile2");
    expect(text).toContain("/DestOutputProfile");
    expect(text).toMatch(/\/ID\s*\[\s*<[0-9a-f]{32}>\s*<[0-9a-f]{32}>\s*\]/);
    expect(text).not.toMatch(/\/BaseFont\s*\/Helvetica/);
  });

  test("same input gives identical bytes", async () => {
    const a = await createEInvoice(pdf, xml(), "zugferd");
    const b = await createEInvoice(pdf, xml(), "zugferd");
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  test("XRechnung: plain XML", async () => {
    const file = await createEInvoice(pdf, xml(), "xrechnung");
    expect(file.extension).toBe("xml");
    const back = await readEInvoice(file.bytes);
    expect(back?.profile).toContain("xrechnung_3.0");
  });

  test("refuses to generate when the check finds errors", async () => {
    const d = xml();
    d.seller.vatId = undefined;
    d.seller.taxNumber = undefined;
    const err = await createEInvoice(pdf, d, "zugferd").catch((e) => e);
    expect(err).toBeInstanceOf(EInvoiceValidationError);
    expect(
      (err as EInvoiceValidationError).issues.map((i) => i.field),
    ).toContain("seller.vatId");
  });

  test("warnings are returned with the file", async () => {
    const d = xml();
    d.items[0].taxRate = 0;
    d.taxGroups = [{ rate: 0, netAmountCents: 24000, amountCents: 0 }];
    d.totals = { netCents: 24000, taxCents: 0, grossCents: 24000 };
    const file = await createEInvoice(
      {
        ...pdf,
        totalCents: 24000,
        taxGroups: [
          { label: "", rate: 0, netAmountCents: 24000, amountCents: 0 },
        ],
      },
      d,
      "zugferd",
    );
    expect(file.warnings.map((w) => w.code)).toEqual(["unsupported"]);
  });
});
