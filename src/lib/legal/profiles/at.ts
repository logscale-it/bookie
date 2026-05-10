import type { LegalProfile } from '../types';

/** Austria — §11 UStG (Austria), ÖNORM A 1080 */
const profile: LegalProfile = {
	countryCode: 'AT',
	label: 'Österreich',
	defaultLocale: 'de',
	requiredPdfFields: [
		'vatId',
		'deliveryDate',
		'invoiceNumber',
		'issuerAddress',
		'recipientAddress',
		'itemDescription',
		'taxBreakdown'
	],
	defaultVatRates: [
		{ name: 'Normalsteuersatz', rate: 20 },
		{ name: 'Ermäßigt', rate: 10 },
		{ name: 'Stark ermäßigt', rate: 13 }
	],
	hasReverseCharge: true,
	reverseChargeLabel: 'Übergang der Steuerschuld auf den Leistungsempfänger (Reverse Charge)',
	smallBusinessExemption: {
		available: true,
		label: 'Umsatzsteuerbefreit — Kleinunternehmerregelung gemäß §6 Abs. 1 Z 27 UStG.'
	},
	layoutStandard: 'oenorm',
	vatIdPattern: /^ATU\d{8}$/,
	vatIdLabel: 'UID-Nummer',
	taxIdLabel: 'Steuernummer',
	dateLocale: 'de-AT',
	numberLocale: 'de-AT',
	// §132 Abs. 1 BAO requires 7 years; we conservatively hold to the German
	// 10-year window until an operator overrides it.
	retentionYears: 10
};

export default profile;
