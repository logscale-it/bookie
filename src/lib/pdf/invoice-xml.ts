/**
 * COMP-3.b: Cross-Industry Invoice (CII) XML emitter.
 *
 * Produces a UN/CEFACT CII XML document for one of two e-invoice flavours
 * Bookie supports today (selected via `settings_organization.einvoice_format`,
 * see COMP-3.a):
 *
 *   - 'zugferd'   — ZUGFeRD 2.x **BASIC** profile (Factur-X 1.0 BASIC)
 *   - 'xrechnung' — XRechnung 3.0 CIUS over CII
 *
 * Both flavours share the same CII schema; only the
 * `GuidelineSpecifiedDocumentContextParameter/ID` differs. This emitter writes
 * the structured XML *only* — the PDF/A-3 wrapping that turns ZUGFeRD into a
 * hybrid invoice lands in COMP-3.c, and Mustangproject round-trip validation
 * lands in COMP-3.d.
 *
 * Field layout follows the Mustangproject schema (`org.mustangproject.ZUGFeRD`)
 * so the resulting XML can be consumed by their validator. Money fields on
 * `InvoiceXmlData` are integer cents (minor currency units) — matching the
 * storage format introduced by migration 0015 (DAT-1.a) — and are converted
 * to two-decimal `Amount` strings at the XML boundary.
 */

/**
 * Subset of `EInvoiceFormat` (COMP-3.a, `settings_organization.einvoice_format`)
 * for which the XML emitter is defined. The third value of `EInvoiceFormat`,
 * `'plain'`, deliberately has no XML representation — the emitter is only
 * called when the user has opted into a structured e-invoice format.
 *
 * Defined locally rather than imported from `$lib/db/types` so this module
 * builds independently of COMP-3.a's settings type, which keeps the emitter
 * usable from places (e.g. background jobs) that don't pull in the settings
 * surface.
 */
export type XmlInvoiceFormat = "zugferd" | "xrechnung";

/**
 * Input to `renderInvoiceXml`.
 *
 * Deliberately decoupled from `InvoicePdfData` so callers can populate it
 * directly from the DB (`Invoice` + `InvoiceItem` rows + `OrganizationSettings`)
 * without going through the PDF render path.
 */
export interface InvoiceXmlData {
  /** Invoice number printed on the document, mapped to ExchangedDocument/ID. */
  invoiceNumber: string;
  /** ISO-8601 issue date (YYYY-MM-DD). Mapped to IssueDateTime (format 102). */
  issueDate: string;
  /** Optional ISO-8601 delivery date (YYYY-MM-DD). Defaults to issueDate. */
  deliveryDate?: string;
  /** Optional ISO-8601 due date (YYYY-MM-DD). */
  dueDate?: string;
  /** ISO 4217 currency code (e.g. 'EUR'). */
  currency: string;
  /** Optional invoice notes — emitted as `IncludedNote/Content`. */
  notes?: string;

  /** Seller / issuer (the Bookie operator). */
  seller: {
    name: string;
    street: string;
    postalCode: string;
    city: string;
    countryCode: string;
    vatId?: string;
    taxNumber?: string;
    bankIban?: string;
    bankBic?: string;
    bankAccountHolder?: string;
  };

  /** Buyer / recipient. */
  buyer: {
    name: string;
    street: string;
    postalCode: string;
    city: string;
    countryCode: string;
    vatId?: string;
  };

  /** Line items. Position is 1-based and emitted as LineID. */
  items: Array<{
    position: number;
    description: string;
    quantity: number;
    unit: string;
    unitPriceNetCents: number;
    lineTotalNetCents: number;
    taxRate: number;
  }>;

  /** Tax breakdown by rate. One ApplicableTradeTax block per group. */
  taxGroups: Array<{
    rate: number;
    netAmountCents: number;
    amountCents: number;
  }>;

  /** Document-level totals. All in minor currency units (cents). */
  totals: {
    netCents: number;
    taxCents: number;
    grossCents: number;
  };
}

// ---------------------------------------------------------------------------
// Format-specific guideline IDs
// ---------------------------------------------------------------------------

/**
 * GuidelineSpecifiedDocumentContextParameter/ID per format.
 *
 * - ZUGFeRD 2.x BASIC (Factur-X 1.0 BASIC) — see Mustangproject's
 *   `Profiles.BASIC.getXMPVersion()` / `getXSDFile()` and the Factur-X spec.
 * - XRechnung 3.0 CIUS over CII — see KoSIT's published guideline URN.
 */
const GUIDELINE_ID: Record<XmlInvoiceFormat, string> = {
  zugferd: "urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic",
  xrechnung:
    "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Escape the five XML metacharacters. Sufficient for element bodies and
 * double-quoted attributes — which is all the emitter writes.
 */
export function escapeXml(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format an integer cent amount as a fixed two-decimal string, e.g.
 * `1999` → `"19.99"`. CII Amount nodes are decimal with a period separator
 * regardless of locale; rounding is half-away-from-zero to match SQLite/JS
 * `Math.round` semantics on positive values and to keep the line-by-line
 * sums consistent with the stored cents.
 */
export function formatCentsAsAmount(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  const whole = Math.trunc(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

/**
 * Convert an ISO-8601 calendar date (YYYY-MM-DD) into the CII basic format
 * 102 (YYYYMMDD). Input is trusted (it comes from the DB `DATE` column or a
 * date input), so we only strip dashes; malformed input returns ''.
 */
export function isoDateToCiiBasic(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}${m[2]}${m[3]}` : "";
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render a CII XML document for the given invoice and target e-invoice
 * format. The output is a complete, namespaced `<rsm:CrossIndustryInvoice>`
 * document beginning with `<?xml version="1.0" encoding="UTF-8"?>`.
 *
 * The structure follows the BASIC profile of CII (which XRechnung CIUS is a
 * subset of) and is intentionally minimal — only the elements actually
 * required by EN 16931 BASIC are emitted, so an empty optional field never
 * produces an empty `<ram:...></ram:...>` placeholder that some validators
 * reject.
 */
export function renderInvoiceXml(
  data: InvoiceXmlData,
  format: XmlInvoiceFormat,
): string {
  const guideline = GUIDELINE_ID[format];
  const issueDate102 = isoDateToCiiBasic(data.issueDate);
  const deliveryDate102 = isoDateToCiiBasic(
    data.deliveryDate || data.issueDate,
  );
  const dueDate102 = isoDateToCiiBasic(data.dueDate);
  const currency = escapeXml(data.currency);

  const itemsXml = data.items.map((item) => renderLineItem(item)).join("");
  const taxXml = data.taxGroups.map((g) => renderTradeTax(g)).join("");
  const noteXml = data.notes
    ? `\n\t\t<ram:IncludedNote><ram:Content>${escapeXml(data.notes)}</ram:Content></ram:IncludedNote>`
    : "";

  const sellerVat = data.seller.vatId
    ? `\n\t\t\t\t<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${escapeXml(data.seller.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`
    : "";
  const sellerTax = data.seller.taxNumber
    ? `\n\t\t\t\t<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${escapeXml(data.seller.taxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>`
    : "";

  const buyerVat = data.buyer.vatId
    ? `\n\t\t\t\t<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${escapeXml(data.buyer.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`
    : "";

  const paymentMeansXml = data.seller.bankIban
    ? renderPaymentMeans(
        data.seller.bankIban,
        data.seller.bankBic,
        data.seller.bankAccountHolder,
      )
    : "";

  const dueDateXml = dueDate102
    ? `\n\t\t\t<ram:SpecifiedTradePaymentTerms>\n\t\t\t\t<ram:DueDateDateTime><udt:DateTimeString format="102">${dueDate102}</udt:DateTimeString></ram:DueDateDateTime>\n\t\t\t</ram:SpecifiedTradePaymentTerms>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">
	<rsm:ExchangedDocumentContext>
		<ram:GuidelineSpecifiedDocumentContextParameter>
			<ram:ID>${escapeXml(guideline)}</ram:ID>
		</ram:GuidelineSpecifiedDocumentContextParameter>
	</rsm:ExchangedDocumentContext>
	<rsm:ExchangedDocument>
		<ram:ID>${escapeXml(data.invoiceNumber)}</ram:ID>
		<ram:TypeCode>380</ram:TypeCode>
		<ram:IssueDateTime>
			<udt:DateTimeString format="102">${issueDate102}</udt:DateTimeString>
		</ram:IssueDateTime>${noteXml}
	</rsm:ExchangedDocument>
	<rsm:SupplyChainTradeTransaction>${itemsXml}
		<ram:ApplicableHeaderTradeAgreement>
			<ram:SellerTradeParty>
				<ram:Name>${escapeXml(data.seller.name)}</ram:Name>
				<ram:PostalTradeAddress>
					<ram:PostcodeCode>${escapeXml(data.seller.postalCode)}</ram:PostcodeCode>
					<ram:LineOne>${escapeXml(data.seller.street)}</ram:LineOne>
					<ram:CityName>${escapeXml(data.seller.city)}</ram:CityName>
					<ram:CountryID>${escapeXml(data.seller.countryCode)}</ram:CountryID>
				</ram:PostalTradeAddress>${sellerVat}${sellerTax}
			</ram:SellerTradeParty>
			<ram:BuyerTradeParty>
				<ram:Name>${escapeXml(data.buyer.name)}</ram:Name>
				<ram:PostalTradeAddress>
					<ram:PostcodeCode>${escapeXml(data.buyer.postalCode)}</ram:PostcodeCode>
					<ram:LineOne>${escapeXml(data.buyer.street)}</ram:LineOne>
					<ram:CityName>${escapeXml(data.buyer.city)}</ram:CityName>
					<ram:CountryID>${escapeXml(data.buyer.countryCode)}</ram:CountryID>
				</ram:PostalTradeAddress>${buyerVat}
			</ram:BuyerTradeParty>
		</ram:ApplicableHeaderTradeAgreement>
		<ram:ApplicableHeaderTradeDelivery>
			<ram:ActualDeliverySupplyChainEvent>
				<ram:OccurrenceDateTime>
					<udt:DateTimeString format="102">${deliveryDate102}</udt:DateTimeString>
				</ram:OccurrenceDateTime>
			</ram:ActualDeliverySupplyChainEvent>
		</ram:ApplicableHeaderTradeDelivery>
		<ram:ApplicableHeaderTradeSettlement>
			<ram:InvoiceCurrencyCode>${currency}</ram:InvoiceCurrencyCode>${paymentMeansXml}${taxXml}${dueDateXml}
			<ram:SpecifiedTradeSettlementHeaderMonetarySummation>
				<ram:LineTotalAmount>${formatCentsAsAmount(data.totals.netCents)}</ram:LineTotalAmount>
				<ram:TaxBasisTotalAmount>${formatCentsAsAmount(data.totals.netCents)}</ram:TaxBasisTotalAmount>
				<ram:TaxTotalAmount currencyID="${currency}">${formatCentsAsAmount(data.totals.taxCents)}</ram:TaxTotalAmount>
				<ram:GrandTotalAmount>${formatCentsAsAmount(data.totals.grossCents)}</ram:GrandTotalAmount>
				<ram:DuePayableAmount>${formatCentsAsAmount(data.totals.grossCents)}</ram:DuePayableAmount>
			</ram:SpecifiedTradeSettlementHeaderMonetarySummation>
		</ram:ApplicableHeaderTradeSettlement>
	</rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}

/**
 * Render one `IncludedSupplyChainTradeLineItem`. The line item carries its
 * own tax category (CategoryCode S = standard) so that BASIC validators can
 * reconcile each line against the document-level ApplicableTradeTax block.
 */
function renderLineItem(item: InvoiceXmlData["items"][number]): string {
  return `
		<ram:IncludedSupplyChainTradeLineItem>
			<ram:AssociatedDocumentLineDocument>
				<ram:LineID>${escapeXml(String(item.position))}</ram:LineID>
			</ram:AssociatedDocumentLineDocument>
			<ram:SpecifiedTradeProduct>
				<ram:Name>${escapeXml(item.description)}</ram:Name>
			</ram:SpecifiedTradeProduct>
			<ram:SpecifiedLineTradeAgreement>
				<ram:NetPriceProductTradePrice>
					<ram:ChargeAmount>${formatCentsAsAmount(item.unitPriceNetCents)}</ram:ChargeAmount>
				</ram:NetPriceProductTradePrice>
			</ram:SpecifiedLineTradeAgreement>
			<ram:SpecifiedLineTradeDelivery>
				<ram:BilledQuantity unitCode="${escapeXml(item.unit || "C62")}">${item.quantity}</ram:BilledQuantity>
			</ram:SpecifiedLineTradeDelivery>
			<ram:SpecifiedLineTradeSettlement>
				<ram:ApplicableTradeTax>
					<ram:TypeCode>VAT</ram:TypeCode>
					<ram:CategoryCode>S</ram:CategoryCode>
					<ram:RateApplicablePercent>${item.taxRate.toFixed(2)}</ram:RateApplicablePercent>
				</ram:ApplicableTradeTax>
				<ram:SpecifiedTradeSettlementLineMonetarySummation>
					<ram:LineTotalAmount>${formatCentsAsAmount(item.lineTotalNetCents)}</ram:LineTotalAmount>
				</ram:SpecifiedTradeSettlementLineMonetarySummation>
			</ram:SpecifiedLineTradeSettlement>
		</ram:IncludedSupplyChainTradeLineItem>`;
}

/**
 * Render one document-level `ApplicableTradeTax` block (one per VAT rate).
 */
function renderTradeTax(group: InvoiceXmlData["taxGroups"][number]): string {
  return `
			<ram:ApplicableTradeTax>
				<ram:CalculatedAmount>${formatCentsAsAmount(group.amountCents)}</ram:CalculatedAmount>
				<ram:TypeCode>VAT</ram:TypeCode>
				<ram:BasisAmount>${formatCentsAsAmount(group.netAmountCents)}</ram:BasisAmount>
				<ram:CategoryCode>S</ram:CategoryCode>
				<ram:RateApplicablePercent>${group.rate.toFixed(2)}</ram:RateApplicablePercent>
			</ram:ApplicableTradeTax>`;
}

/**
 * Render `SpecifiedTradeSettlementPaymentMeans` for SEPA credit transfer.
 * UNTDID 4461 code 58 = "SEPA credit transfer" (BR-DE-1 compatible).
 */
function renderPaymentMeans(
  iban: string,
  bic: string | undefined,
  holder: string | undefined,
): string {
  const holderName = holder
    ? `\n\t\t\t\t\t<ram:AccountName>${escapeXml(holder)}</ram:AccountName>`
    : "";
  const bicXml = bic
    ? `\n\t\t\t\t<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${escapeXml(bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>`
    : "";
  return `
			<ram:SpecifiedTradeSettlementPaymentMeans>
				<ram:TypeCode>58</ram:TypeCode>
				<ram:PayeePartyCreditorFinancialAccount>
					<ram:IBANID>${escapeXml(iban)}</ram:IBANID>${holderName}
				</ram:PayeePartyCreditorFinancialAccount>${bicXml}
			</ram:SpecifiedTradeSettlementPaymentMeans>`;
}
