/**
 * Extract the embedded invoice XML from a ZUGFeRD / Factur-X (PDF/A-3) file.
 * Walks the catalog /Names /EmbeddedFiles name tree with pdf-lib's low-level
 * API and falls back to the catalog /AF array. Prefers the well-known file
 * names (factur-x.xml, zugferd-invoice.xml, xrechnung.xml, ZUGFeRD-invoice.xml).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";

const KNOWN = ["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"];

export const isPdf = (b: Uint8Array): boolean =>
  b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

export async function extractEmbeddedXml(bytes: Uint8Array): Promise<string | null> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const specs: PDFDict[] = [];

  const collect = (node: unknown, depth = 0) => {
    const d = node instanceof PDFRef ? ctx.lookup(node) : node;
    if (!(d instanceof PDFDict) || depth > 8) return;
    const names = d.lookup(PDFName.of("Names"));
    if (names instanceof PDFArray)
      for (let i = 1; i < names.size(); i += 2) {
        const s = names.lookup(i);
        if (s instanceof PDFDict) specs.push(s);
      }
    const k = d.lookup(PDFName.of("Kids"));
    if (k instanceof PDFArray) for (let i = 0; i < k.size(); i++) collect(k.get(i), depth + 1);
  };
  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict) collect(names.get(PDFName.of("EmbeddedFiles")));
  const af = doc.catalog.lookup(PDFName.of("AF"));
  if (af instanceof PDFArray)
    for (let i = 0; i < af.size(); i++) {
      const s = af.lookup(i);
      if (s instanceof PDFDict && !specs.includes(s)) specs.push(s);
    }

  const fname = (s: PDFDict): string => {
    const v = s.lookup(PDFName.of("UF")) ?? s.lookup(PDFName.of("F"));
    return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : "";
  };
  const ordered = [...specs].sort(
    (a, b) =>
      Number(!KNOWN.includes(fname(a).toLowerCase())) - Number(!KNOWN.includes(fname(b).toLowerCase())),
  );
  for (const s of ordered) {
    const ef = s.lookup(PDFName.of("EF"));
    if (!(ef instanceof PDFDict)) continue;
    const stream = ef.lookup(PDFName.of("UF")) ?? ef.lookup(PDFName.of("F"));
    if (!(stream instanceof PDFRawStream)) continue;
    const text = new TextDecoder("utf-8").decode(decodePDFRawStream(stream).decode());
    if (/<\s*(\w+:)?(CrossIndustryInvoice|Invoice|CreditNote)[\s>]/.test(text)) return text;
  }
  return null;
}
