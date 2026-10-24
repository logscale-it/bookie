import type {
  Company,
  Customer,
  Invoice,
  OrganizationSettings,
} from "$lib/db/types";
import type { InvoicePdfData } from "$lib/pdf/invoice-pdf";
import type { InvoiceXmlData } from "$lib/pdf/invoice-xml";

export interface InvoiceXmlSources {
  org: Pick<
    OrganizationSettings,
    | "street"
    | "postal_code"
    | "city"
    | "email"
    | "phone_number"
    | "default_legal_country"
  >;
  company: Company | null;
  customer: Customer | undefined;
  /** BT-10, e.g. the Leitweg-ID of a public-sector buyer. */
  buyerReference?: string;
  /** Issued invoice: its frozen addresses win over the live company/customer. */
  snapshot?: Invoice | null;
}

const compact = (s: string | null | undefined) =>
  (s ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * Structured e-invoice data for the same invoice the PDF shows. The visual
 * data (`pdf`) carries amounts and dates; parties come from the DB rows
 * because `InvoicePdfData` only has them as one-line address strings.
 */
export function buildInvoiceXmlData(
  pdf: InvoicePdfData,
  src: InvoiceXmlSources,
): InvoiceXmlData {
  const { org, company, customer } = src;
  const snap = src.snapshot;
  return {
    invoiceNumber: pdf.invoiceNumber,
    issueDate: pdf.issueDate,
    deliveryDate: pdf.deliveryDate || pdf.issueDate,
    dueDate: pdf.dueDate || undefined,
    currency: pdf.currency,
    buyerReference: src.buyerReference || undefined,
    notes: pdf.notes || undefined,
    servicePeriodStart: pdf.servicePeriodStart || undefined,
    servicePeriodEnd: pdf.servicePeriodEnd || undefined,
    seller: {
      name: pdf.issuerName,
      street: snap?.issuer_street || company?.street || org.street || "",
      postalCode:
        snap?.issuer_postal_code || company?.postal_code || org.postal_code || "",
      city: snap?.issuer_city || company?.city || org.city || "",
      countryCode:
        snap?.issuer_country_code ||
        company?.country_code ||
        org.default_legal_country ||
        "DE",
      vatId: compact(pdf.issuerVatId) || undefined,
      taxNumber: pdf.issuerTaxNumber || undefined,
      bankIban: compact(pdf.issuerBankIban) || undefined,
      bankBic: compact(pdf.issuerBankBic) || undefined,
      bankAccountHolder: pdf.issuerBankAccountHolder || undefined,
      email: org.email || undefined,
      phone: org.phone_number || undefined,
    },
    buyer: {
      name: pdf.recipientName,
      street: snap?.recipient_street || customer?.street || "",
      postalCode: snap?.recipient_postal_code || customer?.postal_code || "",
      city: snap?.recipient_city || customer?.city || "",
      countryCode:
        snap?.recipient_country_code || customer?.country_code || "DE",
      vatId: compact(customer?.vat_id) || undefined,
      email: customer?.email || undefined,
    },
    items: pdf.items.map(
      ({
        position,
        description,
        quantity,
        unit,
        unitPriceNetCents,
        lineTotalNetCents,
        taxRate,
      }) => ({
        position,
        description,
        quantity,
        unit,
        unitPriceNetCents,
        lineTotalNetCents,
        taxRate,
      }),
    ),
    taxGroups: pdf.taxGroups.map(({ rate, netAmountCents, amountCents }) => ({
      rate,
      netAmountCents,
      amountCents,
    })),
    totals: {
      netCents: pdf.subtotalCents,
      taxCents: pdf.totalCents - pdf.subtotalCents,
      grossCents: pdf.totalCents,
    },
  };
}
