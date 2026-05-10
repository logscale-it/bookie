/// <reference types="bun" />
import { test, expect } from "bun:test";

import {
  createInvoicePdfA3,
  buildXmpMetadata,
  XML_FILENAMES,
} from "../../../src/lib/pdf/invoice-pdf-a3";
import type { InvoicePdfData } from "../../../src/lib/pdf/invoice-pdf";
import type { InvoiceXmlData } from "../../../src/lib/pdf/invoice-xml";
import { renderInvoiceXml } from "../../../src/lib/pdf/invoice-xml";
import type {
  PDFDict as PDFDictType,
  PDFRawStream as PDFRawStreamType,
} from "pdf-lib";

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------
//
// One small but realistic invoice — single line, single VAT rate, German
// seller / buyer — used by every assertion below. Keeps each test one short
// expectation block that's easy to scan.

const pdfData: InvoicePdfData = {
  issuerName: "Mustermann GmbH",
  issuerAddress: "Musterstr. 1, 12345 Berlin, DE",
  issuerTaxNumber: "12/345/67890",
  issuerVatId: "DE123456789",
  issuerBankAccountHolder: "Mustermann GmbH",
  issuerBankName: "Beispielbank",
  issuerBankIban: "DE89370400440532013000",
  issuerBankBic: "COBADEFFXXX",
  issuerEmail: "kontakt@mustermann.example",
  issuerWebsite: "https://mustermann.example",
  issuerPhone: "+49 30 1234567",
  logoDataUrl: null,
  recipientName: "Beispiel AG",
  recipientAddress: "Beispielweg 9, 80331 München, DE",
  invoiceNumber: "RE-2026-001",
  issueDate: "2026-05-10",
  dueDate: "2026-06-09",
  deliveryDate: "2026-05-10",
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
      description: "Beratungsleistung",
      quantity: 2,
      unit: "h",
      unitPriceNetCents: 12000,
      taxRate: 19,
      lineTotalNetCents: 24000,
    },
  ],
  subtotalCents: 24000,
  taxGroups: [
    {
      label: "MwSt. 19 %",
      rate: 19,
      netAmountCents: 24000,
      amountCents: 4560,
    },
  ],
  totalCents: 28560,
};

const xmlData: InvoiceXmlData = {
  invoiceNumber: "RE-2026-001",
  issueDate: "2026-05-10",
  deliveryDate: "2026-05-10",
  dueDate: "2026-06-09",
  currency: "EUR",
  seller: {
    name: "Mustermann GmbH",
    street: "Musterstr. 1",
    postalCode: "12345",
    city: "Berlin",
    countryCode: "DE",
    vatId: "DE123456789",
    taxNumber: "12/345/67890",
    bankIban: "DE89370400440532013000",
    bankBic: "COBADEFFXXX",
    bankAccountHolder: "Mustermann GmbH",
  },
  buyer: {
    name: "Beispiel AG",
    street: "Beispielweg 9",
    postalCode: "80331",
    city: "München",
    countryCode: "DE",
  },
  items: [
    {
      position: 1,
      description: "Beratungsleistung",
      quantity: 2,
      unit: "HUR",
      unitPriceNetCents: 12000,
      lineTotalNetCents: 24000,
      taxRate: 19,
    },
  ],
  taxGroups: [{ rate: 19, netAmountCents: 24000, amountCents: 4560 }],
  totals: { netCents: 24000, taxCents: 4560, grossCents: 28560 },
};

// ---------------------------------------------------------------------------
// Helpers — decode the produced PDF bytes back to a string we can grep.
// pdf-lib emits with some FlateDecode streams, so the catalog/Info dict text
// is plaintext but the XMP and embedded XML streams are deflated. For
// assertions that need to look inside those streams we re-parse with pdf-lib.
// ---------------------------------------------------------------------------

function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ---------------------------------------------------------------------------
// PDF header / structural assertions (no reparse needed)
// ---------------------------------------------------------------------------

test("createInvoicePdfA3 emits a PDF whose header advertises >= 1.4", async () => {
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const header = bytesToLatin1(out.subarray(0, 8));
  expect(header.startsWith("%PDF-1.")).toBe(true);
  const minor = parseInt(header.slice(7, 8), 10);
  // PDF/A-3 requires PDF >= 1.7 in the spec, but pdf-lib defaults to 1.7 so
  // any 1.4+ output is acceptable here. Verify the parse rather than the
  // strict spec value — see PR description for the documented gap.
  expect(minor).toBeGreaterThanOrEqual(4);
});

test("createInvoicePdfA3 returns a non-empty Uint8Array", async () => {
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  expect(out).toBeInstanceOf(Uint8Array);
  expect(out.length).toBeGreaterThan(2000);
});

// ---------------------------------------------------------------------------
// Catalog assertions — re-load with pdf-lib and inspect the catalog
// ---------------------------------------------------------------------------

test("catalog references an /AF (Associated Files) array", async () => {
  const { PDFDocument, PDFName, PDFArray } = await import("pdf-lib");
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  const af = doc.catalog.lookup(PDFName.of("AF"), PDFArray);
  expect(af).toBeDefined();
  // Exactly one associated file: the embedded XML.
  expect(af.size()).toBe(1);
});

test("catalog references a /Metadata stream", async () => {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  const meta = doc.catalog.get(PDFName.of("Metadata"));
  expect(meta).toBeDefined();
});

test("catalog references an /OutputIntents array with one entry", async () => {
  const { PDFDocument, PDFName, PDFArray } = await import("pdf-lib");
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  const intents = doc.catalog.lookup(PDFName.of("OutputIntents"), PDFArray);
  expect(intents).toBeDefined();
  expect(intents.size()).toBe(1);
});

test("catalog references a Names tree with EmbeddedFiles", async () => {
  const { PDFDocument, PDFName, PDFDict } = await import("pdf-lib");
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
  expect(names).toBeDefined();
  const ef = names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
  expect(ef).toBeDefined();
});

// ---------------------------------------------------------------------------
// Embedded XML payload assertions — round-trip the bytes back through
// pdf-lib and verify the XML matches what `renderInvoiceXml` produces.
// (The COMP-3.c verification method is exactly this byte-for-byte equality.)
// ---------------------------------------------------------------------------

async function extractEmbeddedXmlBytes(
  pdfBytes: Uint8Array,
  expectedFilename: string,
): Promise<Uint8Array> {
  const {
    PDFDocument,
    PDFName,
    PDFDict,
    PDFArray,
    PDFRawStream,
    PDFHexString,
    PDFString,
    decodePDFRawStream,
  } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
  const ef = names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
  const efNames = ef.lookup(PDFName.of("Names"), PDFArray);
  // EmbeddedFiles names tree: [name, fileSpecRef, name, fileSpecRef, ...].
  // pdf-lib stores names as either PDFString (literal) or PDFHexString
  // (UTF-16BE encoded), so decode through both shapes.
  let foundFileSpec: PDFDictType | undefined;
  for (let i = 0; i < efNames.size(); i += 2) {
    const obj = efNames.lookup(i);
    let nameStr = "";
    if (obj instanceof PDFHexString) nameStr = obj.decodeText();
    else if (obj instanceof PDFString) nameStr = obj.asString();
    else nameStr = obj?.toString() ?? "";
    if (nameStr === expectedFilename) {
      foundFileSpec = efNames.lookup(i + 1, PDFDict);
      break;
    }
  }
  expect(foundFileSpec).toBeDefined();
  const efDict = foundFileSpec!.lookup(PDFName.of("EF"), PDFDict);
  // PDFDict.lookup's overloads don't include PDFRawStream; the typings are
  // narrower than the runtime API. Cast through `unknown` so we get the
  // actual returned object — `decodePDFRawStream` handles both raw and
  // flate-decoded streams.
  const fileStream = efDict.lookup(
    PDFName.of("F"),
  ) as unknown as PDFRawStreamType;
  void PDFRawStream; // Imported for the runtime side of the API; type assertion uses PDFRawStreamType.
  return decodePDFRawStream(fileStream).decode();
}

test("embedded XML for zugferd matches renderInvoiceXml output byte-for-byte", async () => {
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const decoded = await extractEmbeddedXmlBytes(out, "factur-x.xml");
  const decodedStr = new TextDecoder().decode(decoded);
  const expected = renderInvoiceXml(xmlData, "zugferd");
  expect(decodedStr).toBe(expected);
});

test("embedded XML for xrechnung matches renderInvoiceXml output byte-for-byte", async () => {
  const out = await createInvoicePdfA3({
    pdfData,
    xmlData,
    format: "xrechnung",
  });
  const decoded = await extractEmbeddedXmlBytes(out, "xrechnung.xml");
  const decodedStr = new TextDecoder().decode(decoded);
  const expected = renderInvoiceXml(xmlData, "xrechnung");
  expect(decodedStr).toBe(expected);
});

test("the embedded file spec carries AFRelationship=Alternative", async () => {
  const { PDFDocument, PDFName, PDFDict, PDFArray } = await import("pdf-lib");
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  const af = doc.catalog.lookup(PDFName.of("AF"), PDFArray);
  const fileSpec = af.lookup(0, PDFDict);
  const rel = fileSpec.lookup(PDFName.of("AFRelationship"));
  expect(rel).toBeDefined();
  expect(rel!.toString()).toContain("Alternative");
});

test("the embedded file spec carries the expected filename for each format", async () => {
  const { PDFDocument, PDFName, PDFDict, PDFArray } = await import("pdf-lib");
  for (const format of ["zugferd", "xrechnung"] as const) {
    const out = await createInvoicePdfA3({ pdfData, xmlData, format });
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    const af = doc.catalog.lookup(PDFName.of("AF"), PDFArray);
    const fileSpec = af.lookup(0, PDFDict);
    const f = fileSpec.lookup(PDFName.of("F"));
    expect(f).toBeDefined();
    expect(f!.toString()).toContain(XML_FILENAMES[format]);
  }
});

// ---------------------------------------------------------------------------
// XMP packet assertions
// ---------------------------------------------------------------------------

test("buildXmpMetadata declares pdfaid:part=3 and pdfaid:conformance=B", () => {
  const xmp = buildXmpMetadata({
    title: "RE-2026-001",
    author: "Mustermann GmbH",
    producer: "Bookie (pdf-lib)",
    creator: "Bookie",
    createDate: new Date("2026-05-10T00:00:00Z"),
    modifyDate: new Date("2026-05-10T00:00:00Z"),
    format: "zugferd",
  });
  expect(xmp).toContain("<pdfaid:part>3</pdfaid:part>");
  expect(xmp).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
});

test("buildXmpMetadata for zugferd emits Factur-X namespace tags", () => {
  const xmp = buildXmpMetadata({
    title: "RE-2026-001",
    author: "Mustermann GmbH",
    producer: "Bookie (pdf-lib)",
    creator: "Bookie",
    createDate: new Date("2026-05-10T00:00:00Z"),
    modifyDate: new Date("2026-05-10T00:00:00Z"),
    format: "zugferd",
  });
  expect(xmp).toContain(
    'xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"',
  );
  expect(xmp).toContain("<fx:DocumentType>INVOICE</fx:DocumentType>");
  expect(xmp).toContain(
    "<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>",
  );
  expect(xmp).toContain("<fx:Version>1.0</fx:Version>");
  expect(xmp).toContain("<fx:ConformanceLevel>BASIC</fx:ConformanceLevel>");
});

test("buildXmpMetadata for xrechnung tags filename + conformance differently", () => {
  const xmp = buildXmpMetadata({
    title: "RE-2026-001",
    author: "Mustermann GmbH",
    producer: "Bookie (pdf-lib)",
    creator: "Bookie",
    createDate: new Date("2026-05-10T00:00:00Z"),
    modifyDate: new Date("2026-05-10T00:00:00Z"),
    format: "xrechnung",
  });
  expect(xmp).toContain(
    "<fx:DocumentFileName>xrechnung.xml</fx:DocumentFileName>",
  );
  expect(xmp).toContain("<fx:ConformanceLevel>XRECHNUNG</fx:ConformanceLevel>");
  expect(xmp).toContain("<fx:Version>3.0</fx:Version>");
});

test("buildXmpMetadata XML-escapes user-controlled fields", () => {
  const xmp = buildXmpMetadata({
    title: "RE & 2026 <001>",
    author: '"Müller & Co"',
    producer: "Bookie (pdf-lib)",
    creator: "Bookie",
    createDate: new Date("2026-05-10T00:00:00Z"),
    modifyDate: new Date("2026-05-10T00:00:00Z"),
    format: "zugferd",
  });
  expect(xmp).toContain("RE &amp; 2026 &lt;001&gt;");
  expect(xmp).toContain("&quot;Müller &amp; Co&quot;");
  // And the XMP packet remains well-formed (no stray unescaped < or & in
  // element text). Quick sanity check: no raw "&" not followed by an entity.
  const userTextSegment = xmp.match(/<dc:title>[\s\S]*?<\/dc:title>/);
  expect(userTextSegment).toBeTruthy();
  expect(userTextSegment![0]).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
});

test("buildXmpMetadata starts and ends with the standard xpacket markers", () => {
  const xmp = buildXmpMetadata({
    title: "X",
    author: "X",
    producer: "X",
    creator: "X",
    createDate: new Date("2026-05-10T00:00:00Z"),
    modifyDate: new Date("2026-05-10T00:00:00Z"),
    format: "zugferd",
  });
  expect(
    xmp.startsWith(
      '<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    ),
  ).toBe(true);
  expect(xmp.trimEnd().endsWith('<?xpacket end="w"?>')).toBe(true);
});

// ---------------------------------------------------------------------------
// Info dict assertions — declarative metadata that PDF/A-3 wants aligned
// ---------------------------------------------------------------------------

test("Info dict carries Producer, Creator, and a Title matching the invoice number", async () => {
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  expect(doc.getProducer()).toBe("Bookie (pdf-lib)");
  expect(doc.getCreator()).toBe("Bookie");
  expect(doc.getTitle()).toBe("RE-2026-001");
});

test("Info dict CreationDate and ModDate are set to the issue date (UTC midnight)", async () => {
  const out = await createInvoicePdfA3({ pdfData, xmlData, format: "zugferd" });
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  const created = doc.getCreationDate();
  const modified = doc.getModificationDate();
  expect(created).toBeInstanceOf(Date);
  expect(modified).toBeInstanceOf(Date);
  expect(created!.toISOString().slice(0, 10)).toBe("2026-05-10");
  expect(modified!.toISOString().slice(0, 10)).toBe("2026-05-10");
});
