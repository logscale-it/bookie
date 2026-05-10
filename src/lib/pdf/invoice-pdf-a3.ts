/**
 * COMP-3.c: PDF/A-3 wrapper that produces a hybrid e-invoice PDF.
 *
 * Wraps the existing visual invoice PDF (`createInvoicePdf` from
 * `./invoice-pdf-writer`) with the PDF/A-3 metadata that the German B2B
 * e-invoice ecosystem expects:
 *
 *   - The CII XML produced by `renderInvoiceXml` (COMP-3.b) is embedded as
 *     `factur-x.xml` (ZUGFeRD / Factur-X) or `xrechnung.xml` (XRechnung
 *     CIUS) — chosen by the `format` argument.
 *   - The embedded file is registered both via the standard
 *     `EmbeddedFiles` name tree (added automatically by `pdfDoc.attach`)
 *     **and** via the `/AF` (Associated Files) array on the catalog with
 *     `AFRelationship: Alternative` — the PDF/A-3 wiring that pdf-lib
 *     already does for us once `afRelationship` is passed.
 *   - An XMP metadata stream is attached to the catalog declaring
 *     `pdfaid:part=3`, `pdfaid:conformance=B`, plus the Factur-X / ZUGFeRD
 *     namespace (`fx:DocumentType`, `fx:DocumentFileName`, `fx:Version`,
 *     `fx:ConformanceLevel`) — or the corresponding XRechnung tagging.
 *   - The Info dict (Title/Author/Producer/Creator/CreationDate/ModDate)
 *     is filled so the XMP and the Info dict agree, as PDF/A-3 requires.
 *   - An sRGB OutputIntent is registered, since PDF/A bans device-dependent
 *     colour spaces on a page that has none.
 *
 * The visual rendering is byte-for-byte the existing pdf-lib output —
 * this module never re-lays-out or re-flows content.
 *
 * ## What this module does NOT do
 *
 * Full PDF/A-3 conformance (font subset embedding, no transparency, no
 * encryption, ICC profile bytes for the OutputIntent, structure-tree
 * tagging) cannot be guaranteed from pdf-lib + the standard 14 fonts
 * alone. The output here is best-effort: it carries the structural
 * markers a Factur-X / ZUGFeRD consumer (Mustangproject, X-Rechnung
 * validators) needs to find and parse the embedded XML, and declares
 * PDF/A-3 conformance in XMP — but a strict veraPDF run will still flag
 * font and colour-management gaps that need further work in COMP-3.d /
 * follow-ups. See COMP-3.c PR description for the documented gap list.
 */

import { AFRelationship, PDFDocument, PDFName, PDFHexString } from "pdf-lib";
import type { InvoicePdfData } from "./invoice-pdf";
import { createInvoicePdf } from "./invoice-pdf-writer";
import type { InvoiceXmlData, XmlInvoiceFormat } from "./invoice-xml";
import { renderInvoiceXml } from "./invoice-xml";

/** Producer/creator strings shown in the PDF Info dict and in XMP. */
const PRODUCER = "Bookie (pdf-lib)";
const CREATOR = "Bookie";

/**
 * The filename a ZUGFeRD/Factur-X consumer expects to find in the PDF's
 * EmbeddedFiles. Mustangproject and the Factur-X 1.0 spec are explicit:
 * the file MUST be named `factur-x.xml` for Factur-X and ZUGFeRD 2.x.
 *
 * For XRechnung CIUS over CII, KoSIT does not mandate a filename, but
 * the de-facto convention used by validators (and required by the
 * "FACTUR-X" attachment relationship when delivering XRechnung as a
 * hybrid PDF) is `xrechnung.xml`.
 */
export const XML_FILENAMES: Record<XmlInvoiceFormat, string> = {
  zugferd: "factur-x.xml",
  xrechnung: "xrechnung.xml",
};

/**
 * The `<fx:DocumentType>` value in the Factur-X XMP namespace.
 *
 * Per the Factur-X 1.0 spec section 6.2.2: always `INVOICE` for an
 * invoice document (TypeCode 380 in CII).
 */
const FX_DOCUMENT_TYPE = "INVOICE";

/**
 * The `<fx:Version>` value — Factur-X spec version. We emit the BASIC
 * profile of Factur-X 1.0 (matching `renderInvoiceXml`'s ZUGFeRD
 * branch).
 */
const FX_VERSION = "1.0";

/**
 * The `<fx:ConformanceLevel>` value. `BASIC` matches the CII XML
 * actually produced by `renderInvoiceXml` for `format='zugferd'`.
 */
const FX_CONFORMANCE = "BASIC";

export interface CreateInvoicePdfA3Args {
  /** Visual invoice data — same shape `createInvoicePdf` already accepts. */
  pdfData: InvoicePdfData;
  /** Structured invoice data for the embedded CII XML. */
  xmlData: InvoiceXmlData;
  /** Which e-invoice format to wrap as. */
  format: XmlInvoiceFormat;
}

/**
 * Produce a hybrid PDF/A-3 invoice with embedded CII XML.
 *
 * Strategy: render the visual PDF via the existing writer, load it back
 * with pdf-lib, mutate the catalog to add PDF/A-3 metadata, attach the
 * XML, and re-serialise. Visual content is preserved exactly.
 */
export async function createInvoicePdfA3(
  args: CreateInvoicePdfA3Args,
): Promise<Uint8Array> {
  const { pdfData, xmlData, format } = args;

  const visualBytes = await createInvoicePdf(pdfData);
  const xmlString = renderInvoiceXml(xmlData, format);
  const xmlBytes = new TextEncoder().encode(xmlString);

  // Reload — `updateMetadata: false` so pdf-lib doesn't overwrite the Info
  // dict ModDate/CreationDate we set below (PDF/A wants them deterministic
  // and aligned with the XMP metadata).
  const pdfDoc = await PDFDocument.load(visualBytes, { updateMetadata: false });

  // --- Info dict: align with what we'll write in the XMP packet ------------
  // The Title/Author come from the invoice data; CreationDate/ModDate are
  // derived from the issue date (UTC midnight) so a regenerated invoice with
  // the same input data produces the same bytes.
  const issueDateUtc = parseIsoDate(xmlData.issueDate) ?? new Date();
  pdfDoc.setTitle(`${pdfData.invoiceNumber || xmlData.invoiceNumber}`);
  pdfDoc.setAuthor(xmlData.seller.name || pdfData.issuerName || "");
  pdfDoc.setSubject("Invoice");
  pdfDoc.setProducer(PRODUCER);
  pdfDoc.setCreator(CREATOR);
  pdfDoc.setCreationDate(issueDateUtc);
  pdfDoc.setModificationDate(issueDateUtc);

  // --- Embed the XML as an Associated File with AFRelationship=Alternative -
  // pdf-lib's `attach()` registers the file in the EmbeddedFiles name tree
  // AND adds the catalog `/AF` array, both of which PDF/A-3 / Factur-X
  // require. The MIME type `application/xml` is what the Factur-X 1.0 spec
  // (and Mustangproject) match against.
  await pdfDoc.attach(xmlBytes, XML_FILENAMES[format], {
    mimeType: "application/xml",
    description: factorXmlDescription(format),
    creationDate: issueDateUtc,
    modificationDate: issueDateUtc,
    afRelationship: AFRelationship.Alternative,
  });

  // --- XMP metadata stream on the catalog ----------------------------------
  const xmpPacket = buildXmpMetadata({
    title: pdfData.invoiceNumber || xmlData.invoiceNumber,
    author: xmlData.seller.name || pdfData.issuerName || "",
    producer: PRODUCER,
    creator: CREATOR,
    createDate: issueDateUtc,
    modifyDate: issueDateUtc,
    format,
  });
  const xmpBytes = new TextEncoder().encode(xmpPacket);
  const metadataStream = pdfDoc.context.stream(xmpBytes, {
    Type: "Metadata",
    Subtype: "XML",
    Length: xmpBytes.length,
  });
  const metadataRef = pdfDoc.context.register(metadataStream);
  pdfDoc.catalog.set(PDFName.of("Metadata"), metadataRef);

  // --- sRGB OutputIntent ---------------------------------------------------
  // PDF/A bans uncoloured device-dependent rendering, so we declare an sRGB
  // output intent. We do NOT embed the ICC profile bytes (that would
  // require shipping ~3kB of binary ICC data); a strict PDF/A validator
  // will flag this — see the documented gap list in the PR.
  addSrgbOutputIntent(pdfDoc);

  // --- MarkInfo: declare the doc as untagged but well-marked --------------
  pdfDoc.catalog.set(
    PDFName.of("MarkInfo"),
    pdfDoc.context.obj({
      Marked: false,
    }),
  );

  const out = await pdfDoc.save({ useObjectStreams: false });
  return new Uint8Array(out);
}

/**
 * Build the XMP metadata packet declaring PDF/A-3B conformance and the
 * Factur-X / XRechnung custom namespace tags. The output is a UTF-8 XML
 * string with the standard XMP packet header / trailer wrappers.
 *
 * Exposed for tests so the assertion suite can match the exact tags
 * without reparsing the produced PDF.
 */
export function buildXmpMetadata(params: {
  title: string;
  author: string;
  producer: string;
  creator: string;
  createDate: Date;
  modifyDate: Date;
  format: XmlInvoiceFormat;
}): string {
  const { title, author, producer, creator, createDate, modifyDate, format } =
    params;
  const createIso = createDate.toISOString();
  const modifyIso = modifyDate.toISOString();

  // Factur-X / ZUGFeRD declare a dedicated XMP namespace; XRechnung CIUS
  // reuses the same conventions (the de-facto pattern Mustangproject and
  // most validators follow), with `BASIC` swapped for the XRechnung
  // conformance tag.
  const fxNamespace = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";
  const fxBlock =
    format === "zugferd"
      ? `
		<rdf:Description rdf:about=""
				xmlns:fx="${fxNamespace}">
			<fx:DocumentType>${FX_DOCUMENT_TYPE}</fx:DocumentType>
			<fx:DocumentFileName>${XML_FILENAMES.zugferd}</fx:DocumentFileName>
			<fx:Version>${FX_VERSION}</fx:Version>
			<fx:ConformanceLevel>${FX_CONFORMANCE}</fx:ConformanceLevel>
		</rdf:Description>`
      : `
		<rdf:Description rdf:about=""
				xmlns:fx="${fxNamespace}">
			<fx:DocumentType>${FX_DOCUMENT_TYPE}</fx:DocumentType>
			<fx:DocumentFileName>${XML_FILENAMES.xrechnung}</fx:DocumentFileName>
			<fx:Version>3.0</fx:Version>
			<fx:ConformanceLevel>XRECHNUNG</fx:ConformanceLevel>
		</rdf:Description>`;

  return `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Bookie XMP">
	<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
		<rdf:Description rdf:about=""
				xmlns:dc="http://purl.org/dc/elements/1.1/">
			<dc:title>
				<rdf:Alt>
					<rdf:li xml:lang="x-default">${escapeXmlText(title)}</rdf:li>
				</rdf:Alt>
			</dc:title>
			<dc:creator>
				<rdf:Seq>
					<rdf:li>${escapeXmlText(author)}</rdf:li>
				</rdf:Seq>
			</dc:creator>
		</rdf:Description>
		<rdf:Description rdf:about=""
				xmlns:xmp="http://ns.adobe.com/xap/1.0/">
			<xmp:CreatorTool>${escapeXmlText(creator)}</xmp:CreatorTool>
			<xmp:CreateDate>${createIso}</xmp:CreateDate>
			<xmp:ModifyDate>${modifyIso}</xmp:ModifyDate>
		</rdf:Description>
		<rdf:Description rdf:about=""
				xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
			<pdf:Producer>${escapeXmlText(producer)}</pdf:Producer>
		</rdf:Description>
		<rdf:Description rdf:about=""
				xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
			<pdfaid:part>3</pdfaid:part>
			<pdfaid:conformance>B</pdfaid:conformance>
		</rdf:Description>${fxBlock}
	</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Add an sRGB OutputIntent dictionary to the catalog. Required for
 * PDF/A — this provides a colour-space anchor so device-dependent
 * rendering is well-defined.
 *
 * NB: We declare `OutputConditionIdentifier=sRGB` and the ISO standard
 * registry name, but do NOT embed the ICC profile bytes. veraPDF strict
 * mode will flag the missing `DestOutputProfile` — see the gap list.
 */
function addSrgbOutputIntent(pdfDoc: PDFDocument): void {
  const intent = pdfDoc.context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFHexString.fromText("sRGB"),
    RegistryName: PDFHexString.fromText("http://www.color.org"),
    Info: PDFHexString.fromText("sRGB IEC61966-2.1"),
  });
  const intentRef = pdfDoc.context.register(intent);
  const intentsArray = pdfDoc.context.obj([intentRef]);
  pdfDoc.catalog.set(PDFName.of("OutputIntents"), intentsArray);
}

/**
 * Description of the embedded XML, surfaced in PDF readers' attachments
 * panel (and by Mustangproject when it lists candidate files).
 */
function factorXmlDescription(format: XmlInvoiceFormat): string {
  return format === "zugferd"
    ? "ZUGFeRD/Factur-X invoice in CII XML, BASIC profile"
    : "XRechnung 3.0 invoice in CII XML";
}

/**
 * Parse a YYYY-MM-DD string as UTC midnight. Returns null on malformed
 * input so the caller can fall back to `new Date()`.
 */
function parseIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const ts = Date.UTC(yr, mo - 1, da);
  if (Number.isNaN(ts)) return null;
  return new Date(ts);
}

/**
 * XML-escape the five metacharacters. Used for XMP packet content,
 * which is XML.
 */
function escapeXmlText(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Re-export structural helpers consumed by the test suite.
export type { XmlInvoiceFormat, InvoiceXmlData };
export { renderInvoiceXml };
