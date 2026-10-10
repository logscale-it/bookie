/** Normalised view of an incoming e-invoice (EN 16931 subset). Money in integer cents. */
export interface EInvoiceParty {
  name: string;
  street?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  vatId?: string;
  taxNumber?: string;
  email?: string;
}

export interface EInvoiceLine {
  id: string;
  name: string;
  quantity: number;
  unit?: string;
  /** Net unit price as number (may carry more than 2 decimals). */
  unitPrice?: number;
  netCents: number;
  taxRate?: number;
}

export interface EInvoiceTax {
  category?: string;
  rate: number;
  basisCents: number;
  taxCents: number;
}

export interface EInvoice {
  syntax: "ubl" | "cii";
  /** Guideline / customization ID (BT-24), e.g. the XRechnung URN. */
  profile?: string;
  /** 380 = invoice, 381 = credit note, ... (UNTDID 1001). */
  typeCode?: string;
  number: string;
  /** ISO YYYY-MM-DD. */
  issueDate: string;
  dueDate?: string;
  currency: string;
  buyerReference?: string;
  note?: string;
  seller: EInvoiceParty;
  buyer: EInvoiceParty;
  lines: EInvoiceLine[];
  taxes: EInvoiceTax[];
  totals: {
    netCents: number;
    taxCents: number;
    grossCents: number;
    payableCents: number;
  };
}
