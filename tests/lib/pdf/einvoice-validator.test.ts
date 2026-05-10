/// <reference types="bun" />
/**
 * COMP-3.d: End-to-end Mustangproject validator round-trip for the
 * ZUGFeRD (Factur-X 1.0 BASIC) hybrid PDF/A-3 and the standalone
 * XRechnung 3.0 CIUS XML produced by COMP-3.b / COMP-3.c.
 *
 * The decomposition's verification (`api_check`) is:
 *   "cargo test --features e2e einvoice_validator exits 0"
 * Bookie's actual frontend test runner is Bun (see tests/README.md and
 * PR #167/#173, which both deferred Mustangproject validation here);
 * the equivalent local invocation is `bun test einvoice-validator`.
 *
 * Three layers of assertion:
 *
 *   1. Structural (always run, no Java needed) — generate both formats,
 *      write to disk, assert the bytes round-trip back through pdf-lib /
 *      DOM-parse cleanly. Catches any regression in COMP-3.b/COMP-3.c
 *      that would make the Mustangproject result trivially fail.
 *
 *   2. Field round-trip (always run) — extract the embedded XML from the
 *      ZUGFeRD PDF/A-3 and the standalone XRechnung XML and assert the
 *      key invoice fields (number, currency, line totals, grand total,
 *      seller/buyer VAT IDs) appear verbatim. This is the strongest
 *      check available without a JVM.
 *
 *   3. Mustangproject validation (gated on `BOOKIE_TEST_MUSTANG=1`) —
 *      spawn `java -jar $MUSTANG_JAR --action validate --source <file>`
 *      and assert exit 0 + the report does not contain `<summary
 *      status="invalid">`. The reviewer command in the PR description
 *      is the canonical way to opt into this layer.
 *
 * Sandbox notes:
 *
 *   - The Mustangproject CLI is a Java jar not present in this sandbox
 *     (no `java` binary, no `Mustang*.jar`). Layer 3 self-skips with a
 *     clear message and the test still exercises layers 1 and 2 — the
 *     decomposition's `api_check` cannot run end-to-end from the
 *     sandbox, but the structural and field round-trip layers ensure
 *     the artefacts handed to the validator are well-formed.
 *
 *   - When a reviewer wants to run the full check:
 *
 *         curl -L -o /tmp/Mustang-CLI.jar \
 *           https://repo1.maven.org/maven2/org/mustangproject/library/2.16.3/library-2.16.3-shaded.jar
 *         BOOKIE_TEST_MUSTANG=1 MUSTANG_JAR=/tmp/Mustang-CLI.jar \
 *           bun test tests/lib/pdf/einvoice-validator.test.ts
 *
 *     The validator XML report is archived to
 *     `target/einvoice-validator-reports/` for CI to pick up (matches
 *     the issue's "CI archives the validator report" requirement).
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { renderInvoiceXml } from "../../../src/lib/pdf/invoice-xml";
import type { InvoiceXmlData } from "../../../src/lib/pdf/invoice-xml";
import { createInvoicePdfA3 } from "../../../src/lib/pdf/invoice-pdf-a3";
import type { InvoicePdfData } from "../../../src/lib/pdf/invoice-pdf";
import type { PDFDict as PDFDictType } from "pdf-lib";

// ---------------------------------------------------------------------------
// Shared fixture — a single, realistic German B2B invoice. Kept identical in
// shape to the COMP-3.c fixture so the validator sees the same artefact
// that the byte-for-byte equality test in PR #173 already pinned down.
// ---------------------------------------------------------------------------

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
    vatId: "DE987654321",
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
// Test workspace: every test writes its fixture under target/ so a CI job
// can archive the directory regardless of pass/fail. The directory is
// created lazily so the suite still runs in a read-only repo (e.g. nix
// build) provided $TMPDIR is writable.
// ---------------------------------------------------------------------------

const REPORT_DIR =
  process.env.BOOKIE_VALIDATOR_REPORT_DIR ??
  join(process.cwd(), "target", "einvoice-validator-reports");

function ensureReportDir(): string {
  mkdirSync(REPORT_DIR, { recursive: true });
  return REPORT_DIR;
}

function writeFixture(name: string, bytes: Uint8Array | string): string {
  const dir = mkdtempSync(join(tmpdir(), "bookie-einvoice-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

// ---------------------------------------------------------------------------
// Layer 1 — Structural assertions (no JVM needed)
// ---------------------------------------------------------------------------

describe("einvoice_validator structural", () => {
  test("ZUGFeRD PDF/A-3 has a PDF-1.x header and reasonable size", async () => {
    const bytes = await createInvoicePdfA3({
      pdfData,
      xmlData,
      format: "zugferd",
    });
    const path = writeFixture("zugferd.pdf", bytes);
    const onDisk = readFileSync(path);
    expect(onDisk.length).toBe(bytes.length);

    const header = new TextDecoder("latin1").decode(onDisk.subarray(0, 8));
    expect(header.startsWith("%PDF-1.")).toBe(true);
    expect(onDisk.length).toBeGreaterThan(2000);
  });

  test("XRechnung XML is well-formed (XML prolog + balanced root)", () => {
    const xml = renderInvoiceXml(xmlData, "xrechnung");
    const path = writeFixture("xrechnung.xml", xml);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toBe(xml);

    expect(onDisk.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(
      true,
    );
    // CII root element open + close — the strongest well-formedness check
    // available without an XML parser dependency.
    expect(onDisk).toContain("<rsm:CrossIndustryInvoice");
    expect(onDisk.trimEnd().endsWith("</rsm:CrossIndustryInvoice>")).toBe(true);
  });

  test("ZUGFeRD PDF/A-3 has the same XML embedded as renderInvoiceXml emits", async () => {
    const {
      PDFDocument,
      PDFName,
      PDFDict,
      PDFArray,
      PDFHexString,
      PDFString,
      decodePDFRawStream,
    } = await import("pdf-lib");
    const bytes = await createInvoicePdfA3({
      pdfData,
      xmlData,
      format: "zugferd",
    });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
    const ef = names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
    const efNames = ef.lookup(PDFName.of("Names"), PDFArray);

    let foundFileSpec: PDFDictType | undefined;
    for (let i = 0; i < efNames.size(); i += 2) {
      const obj = efNames.lookup(i);
      let nameStr = "";
      if (obj instanceof PDFHexString) nameStr = obj.decodeText();
      else if (obj instanceof PDFString) nameStr = obj.asString();
      else nameStr = obj?.toString() ?? "";
      if (nameStr === "factur-x.xml") {
        foundFileSpec = efNames.lookup(i + 1, PDFDict);
        break;
      }
    }
    expect(foundFileSpec).toBeDefined();
    const efDict = foundFileSpec!.lookup(PDFName.of("EF"), PDFDict);
    // pdf-lib's PDFDict.lookup type narrows to a stricter set than the
    // runtime returns — cast through unknown to grab the raw stream.
    const fileStream = efDict.lookup(PDFName.of("F")) as unknown as Parameters<
      typeof decodePDFRawStream
    >[0];
    const decoded = decodePDFRawStream(fileStream).decode();
    const xmlStr = new TextDecoder().decode(decoded);
    expect(xmlStr).toBe(renderInvoiceXml(xmlData, "zugferd"));
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Field round-trip assertions (key CII fields appear verbatim)
//
// These checks pin the contract Mustangproject parses: invoice number,
// currency, totals, VAT IDs, line totals. If any of them regress, the
// validator-report exit code in layer 3 won't be the place we discover it.
// ---------------------------------------------------------------------------

describe("einvoice_validator field round-trip", () => {
  for (const format of ["zugferd", "xrechnung"] as const) {
    test(`${format} XML carries the invoice number and currency`, () => {
      const xml = renderInvoiceXml(xmlData, format);
      expect(xml).toContain("<ram:ID>RE-2026-001</ram:ID>");
      expect(xml).toContain('currencyID="EUR"');
      expect(xml).toContain(
        "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
      );
    });

    test(`${format} XML carries seller and buyer VAT IDs`, () => {
      const xml = renderInvoiceXml(xmlData, format);
      // schemeID="VA" is the CII code for VAT registration.
      expect(xml).toContain('schemeID="VA">DE123456789');
      expect(xml).toContain('schemeID="VA">DE987654321');
    });

    test(`${format} XML carries the line total and grand total in cents-correct decimals`, () => {
      const xml = renderInvoiceXml(xmlData, format);
      // Line total: 24000 cents -> "240.00"
      expect(xml).toContain(">240.00<");
      // Tax total: 4560 cents -> "45.60"
      expect(xml).toContain(">45.60<");
      // Grand total (gross): 28560 cents -> "285.60"
      expect(xml).toContain(">285.60<");
    });

    test(`${format} XML declares the right guideline / specification ID`, () => {
      const xml = renderInvoiceXml(xmlData, format);
      if (format === "zugferd") {
        expect(xml).toContain(
          "urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic",
        );
      } else {
        expect(xml).toContain(
          "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Layer 3 — Mustangproject validator (gated on BOOKIE_TEST_MUSTANG=1).
//
// When opted in, this layer is the source of truth for COMP-3.d. When not
// opted in, it logs a single skip line and the suite still passes — the
// structural and field-roundtrip layers above are still authoritative
// regression guards.
// ---------------------------------------------------------------------------

interface MustangResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reportPath: string;
}

function runMustangValidator(args: {
  jarPath: string;
  sourcePath: string;
  reportName: string;
}): MustangResult {
  const { jarPath, sourcePath, reportName } = args;
  const reportDir = ensureReportDir();
  const reportPath = join(reportDir, reportName);
  // `--action validate` is the Mustang CLI verb that runs XSD + Schematron
  // for both ZUGFeRD/Factur-X PDFs (it picks the embedded XML automatically)
  // and standalone XRechnung XML files.
  const child = spawnSync(
    "java",
    ["-jar", jarPath, "--action", "validate", "--source", sourcePath],
    {
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  // Mustang prints the validator XML report to stdout. Persist it whether
  // the validator says valid or invalid so CI can archive both shapes.
  writeFileSync(reportPath, stdout || stderr || "");
  return {
    exitCode: child.status ?? -1,
    stdout,
    stderr,
    reportPath,
  };
}

const mustangEnabled = process.env.BOOKIE_TEST_MUSTANG === "1";
const mustangJar = process.env.MUSTANG_JAR ?? "";

describe("einvoice_validator mustang", () => {
  if (!mustangEnabled || !mustangJar) {
    test.skip("Mustangproject validator (set BOOKIE_TEST_MUSTANG=1 and MUSTANG_JAR=<path> to enable)", () => {
      // intentional skip body — see test description.
    });
    return;
  }

  test("ZUGFeRD PDF/A-3 passes the Mustangproject validator", async () => {
    const bytes = await createInvoicePdfA3({
      pdfData,
      xmlData,
      format: "zugferd",
    });
    const sourcePath = writeFixture("RE-2026-001-zugferd.pdf", bytes);
    const result = runMustangValidator({
      jarPath: mustangJar,
      sourcePath,
      reportName: "zugferd-validator-report.xml",
    });
    if (result.exitCode !== 0) {
      console.error(
        `Mustang validator failed for ZUGFeRD PDF.\n` +
          `  exit=${result.exitCode}\n` +
          `  stdout=${result.stdout}\n` +
          `  stderr=${result.stderr}\n` +
          `  report=${result.reportPath}`,
      );
    }
    expect(result.exitCode).toBe(0);
    // Mustang's report XML contains a <summary status="valid|invalid"> line
    // even on exit 0 in some library versions; assert the explicit shape.
    expect(result.stdout).not.toContain('status="invalid"');
  });

  test("XRechnung XML passes the Mustangproject validator", () => {
    const xml = renderInvoiceXml(xmlData, "xrechnung");
    const sourcePath = writeFixture("RE-2026-001-xrechnung.xml", xml);
    const result = runMustangValidator({
      jarPath: mustangJar,
      sourcePath,
      reportName: "xrechnung-validator-report.xml",
    });
    if (result.exitCode !== 0) {
      console.error(
        `Mustang validator failed for XRechnung XML.\n` +
          `  exit=${result.exitCode}\n` +
          `  stdout=${result.stdout}\n` +
          `  stderr=${result.stderr}\n` +
          `  report=${result.reportPath}`,
      );
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('status="invalid"');
  });
});
