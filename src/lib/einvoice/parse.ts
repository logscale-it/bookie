/**
 * Parser for EN 16931 e-invoices: XRechnung / UBL 2.1 (Invoice, CreditNote)
 * and UN/CEFACT CII (XRechnung-CII, ZUGFeRD / Factur-X embedded XML).
 *
 * Reads the business terms Bookie needs for booking and display; it does NOT
 * validate against EN 16931 / XRechnung rules (use the KoSIT validator).
 */
import { at, kids, parseXml, txt, type XmlNode } from "./xml";
import type { EInvoice, EInvoiceLine, EInvoiceParty, EInvoiceTax } from "./types";

export class EInvoiceParseError extends Error {}

/** "1234.50" -> 123450 without float math. Missing/invalid -> 0. */
export function toCents(s: string | undefined): number {
  const m = /^\s*(-?)(\d*)(?:\.(\d*))?\s*$/.exec(s ?? "");
  if (!m || (!m[2] && !m[3])) return 0;
  const frac = (m[3] ?? "").padEnd(3, "0");
  let c = Number(m[2] || "0") * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) c += 1; // half away from zero on |x|
  return m[1] ? -c : c;
}

const num = (s: string | undefined): number => {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : 0;
};

/** "20260131" (CII 102) or "2026-01-31" -> "2026-01-31". */
function isoDate(s: string | undefined): string | undefined {
  const v = s?.trim();
  if (!v) return undefined;
  const c = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (c) return `${c[1]}-${c[2]}-${c[3]}`;
  const i = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return i ? i[1] : undefined;
}

const clean = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
};

export function parseEInvoiceXml(xml: string): EInvoice {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    throw new EInvoiceParseError(e instanceof Error ? e.message : String(e));
  }
  if (root.name === "Invoice" || root.name === "CreditNote") return parseUbl(root);
  if (root.name === "CrossIndustryInvoice") return parseCii(root);
  throw new EInvoiceParseError(`Kein unterstütztes E-Rechnungs-Format (Wurzelelement ${root.name})`);
}

// ---------------------------------------------------------------- UBL

function ublParty(wrapper: XmlNode | undefined): EInvoiceParty {
  const p = at(wrapper, "Party");
  let vatId: string | undefined;
  let taxNumber: string | undefined;
  for (const s of kids(p, "PartyTaxScheme")) {
    const id = txt(s, "CompanyID");
    if (!id) continue;
    if ((txt(s, "TaxScheme", "ID") ?? "VAT").toUpperCase() === "VAT") vatId ??= id;
    else taxNumber ??= id;
  }
  return clean({
    name: txt(p, "PartyLegalEntity", "RegistrationName") ?? txt(p, "PartyName", "Name") ?? "",
    street: txt(p, "PostalAddress", "StreetName"),
    postalCode: txt(p, "PostalAddress", "PostalZone"),
    city: txt(p, "PostalAddress", "CityName"),
    countryCode: txt(p, "PostalAddress", "Country", "IdentificationCode"),
    vatId,
    taxNumber,
    email: txt(p, "Contact", "ElectronicMail"),
  });
}

function parseUbl(r: XmlNode): EInvoice {
  const credit = r.name === "CreditNote";
  const lines: EInvoiceLine[] = kids(r, credit ? "CreditNoteLine" : "InvoiceLine").map((l) => {
    const q = at(l, credit ? "CreditedQuantity" : "InvoicedQuantity");
    return clean({
      id: txt(l, "ID") ?? "",
      name: txt(l, "Item", "Name") ?? txt(l, "Item", "Description") ?? "",
      quantity: num(q?.text),
      unit: q?.attrs.unitCode,
      unitPrice: txt(l, "Price", "PriceAmount") ? num(txt(l, "Price", "PriceAmount")) : undefined,
      netCents: toCents(txt(l, "LineExtensionAmount")),
      taxRate: txt(l, "Item", "ClassifiedTaxCategory", "Percent")
        ? num(txt(l, "Item", "ClassifiedTaxCategory", "Percent"))
        : undefined,
    });
  });
  const taxes: EInvoiceTax[] = kids(at(r, "TaxTotal"), "TaxSubtotal").map((s) =>
    clean({
      category: txt(s, "TaxCategory", "ID"),
      rate: num(txt(s, "TaxCategory", "Percent")),
      basisCents: toCents(txt(s, "TaxableAmount")),
      taxCents: toCents(txt(s, "TaxAmount")),
    }),
  );
  const m = at(r, "LegalMonetaryTotal");
  const net = toCents(txt(m, "TaxExclusiveAmount") ?? txt(m, "LineExtensionAmount"));
  const gross = toCents(txt(m, "TaxInclusiveAmount"));
  return clean({
    syntax: "ubl" as const,
    profile: txt(r, "CustomizationID"),
    typeCode: txt(r, credit ? "CreditNoteTypeCode" : "InvoiceTypeCode") ?? (credit ? "381" : undefined),
    number: txt(r, "ID") ?? "",
    issueDate: isoDate(txt(r, "IssueDate")) ?? "",
    dueDate: isoDate(txt(r, "DueDate") ?? txt(r, "PaymentMeans", "PaymentDueDate")),
    currency: txt(r, "DocumentCurrencyCode") ?? "EUR",
    buyerReference: txt(r, "BuyerReference"),
    note: txt(r, "Note"),
    seller: ublParty(at(r, "AccountingSupplierParty")),
    buyer: ublParty(at(r, "AccountingCustomerParty")),
    lines,
    taxes,
    totals: {
      netCents: net,
      taxCents: txt(r, "TaxTotal", "TaxAmount") ? toCents(txt(r, "TaxTotal", "TaxAmount")) : gross - net,
      grossCents: gross,
      payableCents: txt(m, "PayableAmount") ? toCents(txt(m, "PayableAmount")) : gross,
    },
  });
}

// ---------------------------------------------------------------- CII

function ciiParty(p: XmlNode | undefined): EInvoiceParty {
  let vatId: string | undefined;
  let taxNumber: string | undefined;
  for (const reg of kids(p, "SpecifiedTaxRegistration")) {
    const id = at(reg, "ID");
    if (!id?.text.trim()) continue;
    if (id.attrs.schemeID === "VA") vatId ??= id.text.trim();
    else if (id.attrs.schemeID === "FC") taxNumber ??= id.text.trim();
  }
  return clean({
    name: txt(p, "Name") ?? txt(p, "SpecifiedLegalOrganization", "TradingBusinessName") ?? "",
    street: txt(p, "PostalTradeAddress", "LineOne"),
    postalCode: txt(p, "PostalTradeAddress", "PostcodeCode"),
    city: txt(p, "PostalTradeAddress", "CityName"),
    countryCode: txt(p, "PostalTradeAddress", "CountryID"),
    vatId,
    taxNumber,
    email:
      txt(p, "DefinedTradeContact", "EmailURIUniversalCommunication", "URIID") ??
      txt(p, "URIUniversalCommunication", "URIID"),
  });
}

function parseCii(r: XmlNode): EInvoice {
  const doc = at(r, "ExchangedDocument");
  const tx = at(r, "SupplyChainTradeTransaction");
  const agr = at(tx, "ApplicableHeaderTradeAgreement");
  const set = at(tx, "ApplicableHeaderTradeSettlement");
  const sum = at(set, "SpecifiedTradeSettlementHeaderMonetarySummation");

  const lines: EInvoiceLine[] = kids(tx, "IncludedSupplyChainTradeLineItem").map((l) => {
    const q = at(l, "SpecifiedLineTradeDelivery", "BilledQuantity");
    const price = txt(l, "SpecifiedLineTradeAgreement", "NetPriceProductTradePrice", "ChargeAmount");
    const rate = txt(l, "SpecifiedLineTradeSettlement", "ApplicableTradeTax", "RateApplicablePercent");
    return clean({
      id: txt(l, "AssociatedDocumentLineDocument", "LineID") ?? "",
      name: txt(l, "SpecifiedTradeProduct", "Name") ?? "",
      quantity: num(q?.text),
      unit: q?.attrs.unitCode,
      unitPrice: price ? num(price) : undefined,
      netCents: toCents(
        txt(l, "SpecifiedLineTradeSettlement", "SpecifiedTradeSettlementLineMonetarySummation", "LineTotalAmount"),
      ),
      taxRate: rate ? num(rate) : undefined,
    });
  });
  const taxes: EInvoiceTax[] = kids(set, "ApplicableTradeTax").map((t) =>
    clean({
      category: txt(t, "CategoryCode"),
      rate: num(txt(t, "RateApplicablePercent")),
      basisCents: toCents(txt(t, "BasisAmount")),
      taxCents: toCents(txt(t, "CalculatedAmount")),
    }),
  );
  const net = toCents(txt(sum, "TaxBasisTotalAmount") ?? txt(sum, "LineTotalAmount"));
  const gross = toCents(txt(sum, "GrandTotalAmount"));
  return clean({
    syntax: "cii" as const,
    profile: txt(r, "ExchangedDocumentContext", "GuidelineSpecifiedDocumentContextParameter", "ID"),
    typeCode: txt(doc, "TypeCode"),
    number: txt(doc, "ID") ?? "",
    issueDate: isoDate(txt(doc, "IssueDateTime", "DateTimeString")) ?? "",
    dueDate: isoDate(txt(set, "SpecifiedTradePaymentTerms", "DueDateDateTime", "DateTimeString")),
    currency: txt(set, "InvoiceCurrencyCode") ?? "EUR",
    buyerReference: txt(agr, "BuyerReference"),
    note: txt(doc, "IncludedNote", "Content"),
    seller: ciiParty(at(agr, "SellerTradeParty")),
    buyer: ciiParty(at(agr, "BuyerTradeParty")),
    lines,
    taxes,
    totals: {
      netCents: net,
      taxCents: toCents(txt(sum, "TaxTotalAmount")),
      grossCents: gross,
      payableCents: txt(sum, "DuePayableAmount") ? toCents(txt(sum, "DuePayableAmount")) : gross,
    },
  });
}
