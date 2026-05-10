import type { Locale } from '$lib/i18n';

export type LegalCountry = 'DE' | 'AT' | 'CH' | 'FR' | 'NL' | 'US';

export interface LegalProfile {
	/** ISO country code */
	countryCode: LegalCountry;
	/** Display label */
	label: string;
	/** Default locale for this country */
	defaultLocale: Locale;
	/** Fields that are mandatory on invoice PDF */
	requiredPdfFields: LegalRequiredField[];
	/** Default VAT rates for this country */
	defaultVatRates: { name: string; rate: number }[];
	/** Whether reverse charge mechanism exists */
	hasReverseCharge: boolean;
	/** Reverse charge notice text (in the country's language) */
	reverseChargeLabel: string;
	/** Small business exemption info */
	smallBusinessExemption: {
		available: boolean;
		/** Legal notice to print on invoice */
		label: string;
	};
	/** Layout standard for business correspondence */
	layoutStandard: 'din5008' | 'oenorm' | 'generic';
	/** VAT ID regex for validation */
	vatIdPattern: RegExp;
	/** VAT ID label (e.g. USt-IdNr., TVA, BTW) */
	vatIdLabel: string;
	/** Tax ID label (e.g. Steuernummer, SIREN) */
	taxIdLabel: string;
	/** Date format for display (Intl locale string) */
	dateLocale: string;
	/** Number format locale */
	numberLocale: string;
	/**
	 * Years that booking-relevant records (invoices, payments, audit rows)
	 * must be retained before destructive operations are permitted.
	 *
	 * COMP-1.a: GoBD §147 AO requires 10 years for the German profile;
	 * other jurisdictions default to the same window so the guard is
	 * conservative wherever the operator has not made a deliberate choice.
	 */
	retentionYears: number;
}

export type LegalRequiredField =
	| 'vatId'
	| 'taxId'
	| 'deliveryDate'
	| 'invoiceNumber'
	| 'issuerAddress'
	| 'recipientAddress'
	| 'itemDescription'
	| 'taxBreakdown'
	| 'bankDetails'
	| 'registrationId';
