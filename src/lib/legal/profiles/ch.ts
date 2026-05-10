import type { LegalProfile } from '../types';

/** Switzerland — MWSTG (Mehrwertsteuergesetz) */
const profile: LegalProfile = {
	countryCode: 'CH',
	label: 'Schweiz',
	defaultLocale: 'de',
	requiredPdfFields: [
		'vatId',
		'invoiceNumber',
		'issuerAddress',
		'recipientAddress',
		'itemDescription',
		'taxBreakdown'
	],
	defaultVatRates: [
		{ name: 'Normalsatz', rate: 8.1 },
		{ name: 'Reduziert', rate: 2.6 },
		{ name: 'Sondersatz', rate: 3.8 }
	],
	hasReverseCharge: true,
	reverseChargeLabel: 'Bezugsteuer (Reverse Charge)',
	smallBusinessExemption: {
		available: true,
		label: 'Von der Mehrwertsteuer befreit (Umsatz unter CHF 100\'000).'
	},
	layoutStandard: 'generic',
	vatIdPattern: /^CHE-?\d{3}\.?\d{3}\.?\d{3}\s?MWST$/,
	vatIdLabel: 'MWST-Nr.',
	taxIdLabel: 'UID',
	dateLocale: 'de-CH',
	numberLocale: 'de-CH',
	// Art. 70 MWSTG / Art. 958f OR — booking records: 10 years.
	retentionYears: 10
};

export default profile;
