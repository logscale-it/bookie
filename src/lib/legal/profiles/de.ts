import type { LegalProfile } from '../types';

/** Germany — §14 Abs. 4 UStG, DIN 5008 */
const profile: LegalProfile = {
	countryCode: 'DE',
	label: 'Deutschland',
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
		{ name: 'Regelsteuersatz', rate: 19 },
		{ name: 'Ermäßigt', rate: 7 }
	],
	hasReverseCharge: true,
	reverseChargeLabel: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)',
	smallBusinessExemption: {
		available: true,
		label: 'Gemäß §19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).'
	},
	layoutStandard: 'din5008',
	vatIdPattern: /^DE\d{9}$/,
	vatIdLabel: 'USt-IdNr.',
	taxIdLabel: 'Steuernummer',
	dateLocale: 'de-DE',
	numberLocale: 'de-DE',
	// §147 Abs. 3 AO — booking-relevant records: 10 years.
	retentionYears: 10
};

export default profile;
