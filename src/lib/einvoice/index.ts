import { parseEInvoiceXml } from "./parse";
import { extractEmbeddedXml, isPdf } from "./pdf";
import type { EInvoice } from "./types";

export * from "./types";
export { parseEInvoiceXml, EInvoiceParseError, toCents } from "./parse";
export { extractEmbeddedXml } from "./pdf";

/**
 * Detect and parse an uploaded file. Returns null when it is not an e-invoice
 * (image, plain PDF without embedded XML, other text). Throws
 * EInvoiceParseError when it claims to be one but cannot be read.
 * The input bytes are never modified.
 */
export async function readEInvoice(bytes: Uint8Array): Promise<EInvoice | null> {
  if (isPdf(bytes)) {
    let xml: string | null;
    try {
      xml = await extractEmbeddedXml(bytes);
    } catch {
      return null; // unreadable PDF: treat as plain PDF, still archived as-is
    }
    return xml ? parseEInvoiceXml(xml) : null;
  }
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 2048));
  if (!/<\s*(\?xml|(\w+:)?(Invoice|CreditNote|CrossIndustryInvoice))/.test(head)) return null;
  return parseEInvoiceXml(new TextDecoder("utf-8").decode(bytes));
}
