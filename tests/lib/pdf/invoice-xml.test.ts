/// <reference types="bun" />
import { test, expect, describe } from "bun:test";

import {
  renderInvoiceXml,
  escapeXml,
  formatCentsAsAmount,
  isoDateToCiiBasic,
  type InvoiceXmlData,
} from "../../../src/lib/pdf/invoice-xml";

// COMP-3.b: A representative DE B2B invoice — the worked example used to
// pin down the structural assertions below. Two line items, two VAT groups
// (19% and 7%), full SEPA payment-means, both seller and buyer VAT IDs.
const FIXTURE: InvoiceXmlData = {
  invoiceNumber: "RE-2026-0001",
  issueDate: "2026-05-10",
  deliveryDate: "2026-05-09",
  dueDate: "2026-05-24",
  currency: "EUR",
  notes: "Vielen Dank für Ihren Auftrag.",
  seller: {
    name: "Acme GmbH",
    street: "Musterstr. 1",
    postalCode: "10115",
    city: "Berlin",
    countryCode: "DE",
    vatId: "DE123456789",
    taxNumber: "12/345/67890",
    bankIban: "DE89370400440532013000",
    bankBic: "COBADEFFXXX",
    bankAccountHolder: "Acme GmbH",
  },
  buyer: {
    name: "Globex SE",
    street: "Hauptweg 42",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE",
    vatId: "DE987654321",
  },
  items: [
    {
      position: 1,
      description: "Beratung Q2",
      quantity: 8,
      unit: "HUR",
      unitPriceNetCents: 12000,
      lineTotalNetCents: 96000,
      taxRate: 19,
    },
    {
      position: 2,
      description: "Buchproduktion",
      quantity: 2,
      unit: "C62",
      unitPriceNetCents: 5000,
      lineTotalNetCents: 10000,
      taxRate: 7,
    },
  ],
  taxGroups: [
    { rate: 19, netAmountCents: 96000, amountCents: 18240 },
    { rate: 7, netAmountCents: 10000, amountCents: 700 },
  ],
  totals: {
    netCents: 106000,
    taxCents: 18940,
    grossCents: 124940,
  },
};

// ---------------------------------------------------------------------------
// formatCentsAsAmount
// ---------------------------------------------------------------------------

describe("formatCentsAsAmount", () => {
  test("renders integer cents as fixed two-decimal", () => {
    expect(formatCentsAsAmount(0)).toBe("0.00");
    expect(formatCentsAsAmount(1)).toBe("0.01");
    expect(formatCentsAsAmount(99)).toBe("0.99");
    expect(formatCentsAsAmount(100)).toBe("1.00");
    expect(formatCentsAsAmount(1999)).toBe("19.99");
    expect(formatCentsAsAmount(124940)).toBe("1249.40");
  });

  test("handles negatives (e.g. credit notes) with leading minus", () => {
    expect(formatCentsAsAmount(-1)).toBe("-0.01");
    expect(formatCentsAsAmount(-12345)).toBe("-123.45");
  });

  test("rounds non-integer input and coerces non-finite to 0", () => {
    expect(formatCentsAsAmount(199.4)).toBe("1.99");
    expect(formatCentsAsAmount(199.5)).toBe("2.00");
    expect(formatCentsAsAmount(NaN)).toBe("0.00");
    expect(formatCentsAsAmount(Infinity)).toBe("0.00");
  });

  test("never uses a locale separator (CII demands period)", () => {
    // Even though Bookie's UI uses German locale ('1.249,40 €'), CII
    // Amount nodes are decimal with a period. Catch a regression that
    // accidentally runs the value through Intl.NumberFormat.
    const out = formatCentsAsAmount(124940);
    expect(out).not.toContain(",");
    expect(out).toBe("1249.40");
  });
});

// ---------------------------------------------------------------------------
// isoDateToCiiBasic
// ---------------------------------------------------------------------------

describe("isoDateToCiiBasic", () => {
  test("strips dashes from a YYYY-MM-DD date", () => {
    expect(isoDateToCiiBasic("2026-05-10")).toBe("20260510");
  });

  test("accepts a full ISO timestamp by truncating to date", () => {
    expect(isoDateToCiiBasic("2026-05-10T12:34:56Z")).toBe("20260510");
  });

  test("returns '' for empty / null / malformed input", () => {
    expect(isoDateToCiiBasic("")).toBe("");
    expect(isoDateToCiiBasic(null)).toBe("");
    expect(isoDateToCiiBasic(undefined)).toBe("");
    expect(isoDateToCiiBasic("not-a-date")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// escapeXml
// ---------------------------------------------------------------------------

describe("escapeXml", () => {
  test("escapes the five XML metacharacters", () => {
    expect(escapeXml(`<a b="c" d='e'>&`)).toBe(
      "&lt;a b=&quot;c&quot; d=&apos;e&apos;&gt;&amp;",
    );
  });

  test("treats null/undefined as empty string", () => {
    expect(escapeXml(null)).toBe("");
    expect(escapeXml(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// renderInvoiceXml — structural assertions
//
// We deliberately do *not* snapshot the entire XML string here — Mustangproject
// round-trip validation lands in COMP-3.d. Instead we assert the load-bearing
// nodes that EN 16931 BR-* rules and the Mustangproject schema demand are
// present, in the right namespace, and carry the expected values.
// ---------------------------------------------------------------------------

describe("renderInvoiceXml", () => {
  test("emits an XML 1.0 prolog and the CII root with all four namespaces", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<rsm:CrossIndustryInvoice");
    expect(xml).toContain(
      'xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
    );
    expect(xml).toContain(
      'xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"',
    );
    expect(xml).toContain(
      'xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"',
    );
    expect(xml).toContain(
      'xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"',
    );
    expect(xml.trim().endsWith("</rsm:CrossIndustryInvoice>")).toBe(true);
  });

  test("guideline ID switches between ZUGFeRD BASIC and XRechnung 3.0", () => {
    const z = renderInvoiceXml(FIXTURE, "zugferd");
    const x = renderInvoiceXml(FIXTURE, "xrechnung");

    expect(z).toContain(
      "<ram:ID>urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic</ram:ID>",
    );
    expect(x).toContain(
      "<ram:ID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</ram:ID>",
    );

    // Sanity: the two XMLs should not share the same guideline.
    expect(z).not.toContain("xrechnung_3.0");
    expect(x).not.toContain("factur-x.eu:1p0:basic");
  });

  test("ExchangedDocument carries invoice number, type 380 and date 102", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    expect(xml).toContain("<ram:ID>RE-2026-0001</ram:ID>");
    expect(xml).toContain("<ram:TypeCode>380</ram:TypeCode>");
    expect(xml).toMatch(
      /<ram:IssueDateTime>\s*<udt:DateTimeString format="102">20260510<\/udt:DateTimeString>\s*<\/ram:IssueDateTime>/,
    );
  });

  test("notes are emitted as IncludedNote/Content (escaped)", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    expect(xml).toContain(
      "<ram:IncludedNote><ram:Content>Vielen Dank für Ihren Auftrag.</ram:Content></ram:IncludedNote>",
    );

    // And the note is omitted entirely when not provided.
    const xmlNoNote = renderInvoiceXml(
      { ...FIXTURE, notes: undefined },
      "zugferd",
    );
    expect(xmlNoNote).not.toContain("<ram:IncludedNote>");
  });

  test("seller and buyer parties carry name, address and VAT IDs (schemeID=VA)", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    expect(xml).toContain("<ram:SellerTradeParty>");
    expect(xml).toContain("<ram:Name>Acme GmbH</ram:Name>");
    expect(xml).toContain("<ram:PostcodeCode>10115</ram:PostcodeCode>");
    expect(xml).toContain("<ram:LineOne>Musterstr. 1</ram:LineOne>");
    expect(xml).toContain("<ram:CityName>Berlin</ram:CityName>");
    expect(xml).toContain("<ram:CountryID>DE</ram:CountryID>");
    expect(xml).toContain(
      '<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID></ram:SpecifiedTaxRegistration>',
    );
    expect(xml).toContain(
      '<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">12/345/67890</ram:ID></ram:SpecifiedTaxRegistration>',
    );

    expect(xml).toContain("<ram:BuyerTradeParty>");
    expect(xml).toContain("<ram:Name>Globex SE</ram:Name>");
    expect(xml).toContain(
      '<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE987654321</ram:ID></ram:SpecifiedTaxRegistration>',
    );
  });

  test("optional seller/buyer fields are omitted (no empty placeholder elements)", () => {
    const minimal: InvoiceXmlData = {
      ...FIXTURE,
      notes: undefined,
      dueDate: undefined,
      seller: {
        ...FIXTURE.seller,
        vatId: undefined,
        taxNumber: undefined,
        bankIban: undefined,
        bankBic: undefined,
        bankAccountHolder: undefined,
      },
      buyer: { ...FIXTURE.buyer, vatId: undefined },
    };
    const xml = renderInvoiceXml(minimal, "zugferd");

    // No placeholder tax-registration / payment-means / due-date blocks.
    expect(xml).not.toContain("<ram:SpecifiedTaxRegistration>");
    expect(xml).not.toContain("<ram:SpecifiedTradeSettlementPaymentMeans>");
    expect(xml).not.toContain("<ram:SpecifiedTradePaymentTerms>");
    expect(xml).not.toContain("<ram:IncludedNote>");
  });

  test("delivery-date defaults to issue-date when not supplied", () => {
    const xml = renderInvoiceXml(
      { ...FIXTURE, deliveryDate: undefined },
      "zugferd",
    );
    // Expect issue-date 102 inside ActualDeliverySupplyChainEvent.
    expect(xml).toMatch(
      /<ram:ActualDeliverySupplyChainEvent>\s*<ram:OccurrenceDateTime>\s*<udt:DateTimeString format="102">20260510<\/udt:DateTimeString>/,
    );
  });

  test("emits one IncludedSupplyChainTradeLineItem per item, with LineID, name and amounts", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    const lineCount = (
      xml.match(/<ram:IncludedSupplyChainTradeLineItem>/g) || []
    ).length;
    expect(lineCount).toBe(2);

    // Line 1 — 8 hours at 120,00 € net = 960,00 € net.
    expect(xml).toContain("<ram:LineID>1</ram:LineID>");
    expect(xml).toContain("<ram:Name>Beratung Q2</ram:Name>");
    expect(xml).toContain(
      '<ram:BilledQuantity unitCode="HUR">8</ram:BilledQuantity>',
    );
    expect(xml).toContain("<ram:ChargeAmount>120.00</ram:ChargeAmount>");
    expect(xml).toContain("<ram:LineTotalAmount>960.00</ram:LineTotalAmount>");

    // Line 2 — 2 × 50,00 € net = 100,00 € net at 7 %.
    expect(xml).toContain("<ram:LineID>2</ram:LineID>");
    expect(xml).toContain("<ram:Name>Buchproduktion</ram:Name>");
    expect(xml).toContain(
      '<ram:BilledQuantity unitCode="C62">2</ram:BilledQuantity>',
    );
    expect(xml).toContain("<ram:ChargeAmount>50.00</ram:ChargeAmount>");
    expect(xml).toContain("<ram:LineTotalAmount>100.00</ram:LineTotalAmount>");

    // Each line carries an ApplicableTradeTax with CategoryCode S and the rate.
    expect(xml).toContain(
      "<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>",
    );
    expect(xml).toContain(
      "<ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>",
    );
  });

  test("emits one document-level ApplicableTradeTax per VAT group", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    // Two line-level + two header-level = four ApplicableTradeTax openings.
    const occurrences = (xml.match(/<ram:ApplicableTradeTax>/g) || []).length;
    expect(occurrences).toBe(4);

    // Header 19 % group: basis 960,00 € → 182,40 € VAT.
    expect(xml).toMatch(
      /<ram:CalculatedAmount>182\.40<\/ram:CalculatedAmount>[\s\S]*?<ram:BasisAmount>960\.00<\/ram:BasisAmount>/,
    );
    // Header 7 % group: basis 100,00 € → 7,00 € VAT.
    expect(xml).toMatch(
      /<ram:CalculatedAmount>7\.00<\/ram:CalculatedAmount>[\s\S]*?<ram:BasisAmount>100\.00<\/ram:BasisAmount>/,
    );
  });

  test("monetary summation totals are written from cents", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    expect(xml).toContain("<ram:LineTotalAmount>1060.00</ram:LineTotalAmount>");
    expect(xml).toContain(
      "<ram:TaxBasisTotalAmount>1060.00</ram:TaxBasisTotalAmount>",
    );
    expect(xml).toContain(
      '<ram:TaxTotalAmount currencyID="EUR">189.40</ram:TaxTotalAmount>',
    );
    expect(xml).toContain(
      "<ram:GrandTotalAmount>1249.40</ram:GrandTotalAmount>",
    );
    expect(xml).toContain(
      "<ram:DuePayableAmount>1249.40</ram:DuePayableAmount>",
    );
  });

  test("payment means (SEPA, code 58) are emitted with IBAN, BIC and account holder", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    expect(xml).toContain("<ram:SpecifiedTradeSettlementPaymentMeans>");
    expect(xml).toContain("<ram:TypeCode>58</ram:TypeCode>");
    expect(xml).toContain("<ram:IBANID>DE89370400440532013000</ram:IBANID>");
    expect(xml).toContain("<ram:AccountName>Acme GmbH</ram:AccountName>");
    expect(xml).toContain("<ram:BICID>COBADEFFXXX</ram:BICID>");
  });

  test("due-date payment terms are emitted when dueDate is set", () => {
    const xml = renderInvoiceXml(FIXTURE, "zugferd");
    expect(xml).toMatch(
      /<ram:SpecifiedTradePaymentTerms>\s*<ram:DueDateDateTime>\s*<udt:DateTimeString format="102">20260524<\/udt:DateTimeString>/,
    );
  });

  test("XML metacharacters in user data are escaped", () => {
    const naughty: InvoiceXmlData = {
      ...FIXTURE,
      invoiceNumber: 'RE&"<>2026',
      seller: { ...FIXTURE.seller, name: "A&B GmbH <Holding>" },
      items: [
        {
          position: 1,
          description: 'Beratung "Q2" & Co.',
          quantity: 1,
          unit: "C62",
          unitPriceNetCents: 100,
          lineTotalNetCents: 100,
          taxRate: 19,
        },
      ],
      taxGroups: [{ rate: 19, netAmountCents: 100, amountCents: 19 }],
      totals: { netCents: 100, taxCents: 19, grossCents: 119 },
    };
    const xml = renderInvoiceXml(naughty, "zugferd");
    expect(xml).toContain("<ram:ID>RE&amp;&quot;&lt;&gt;2026</ram:ID>");
    expect(xml).toContain("<ram:Name>A&amp;B GmbH &lt;Holding&gt;</ram:Name>");
    expect(xml).toContain(
      "<ram:Name>Beratung &quot;Q2&quot; &amp; Co.</ram:Name>",
    );
    // No raw '&' / '<' / '>' / unescaped quotes in element bodies.
    expect(xml).not.toMatch(/<ram:Name>[^<]*&[^a-z#]/);
  });

  test("currency code propagates to InvoiceCurrencyCode and TaxTotalAmount@currencyID", () => {
    const usd = renderInvoiceXml({ ...FIXTURE, currency: "USD" }, "xrechnung");
    expect(usd).toContain(
      "<ram:InvoiceCurrencyCode>USD</ram:InvoiceCurrencyCode>",
    );
    expect(usd).toContain('<ram:TaxTotalAmount currencyID="USD">');
  });
});
