import type { LegalProfile } from '../types';

/** France — Code général des impôts, Art. 289 */
const profile: LegalProfile = {
	countryCode: 'FR',
	label: 'France',
	defaultLocale: 'en',
	requiredPdfFields: [
		'vatId',
		'registrationId',
		'invoiceNumber',
		'issuerAddress',
		'recipientAddress',
		'itemDescription',
		'taxBreakdown'
	],
	defaultVatRates: [
		{ name: 'Taux normal', rate: 20 },
		{ name: 'Taux intermédiaire', rate: 10 },
		{ name: 'Taux réduit', rate: 5.5 },
		{ name: 'Taux super-réduit', rate: 2.1 }
	],
	hasReverseCharge: true,
	reverseChargeLabel: 'Autoliquidation de la TVA (Reverse Charge)',
	smallBusinessExemption: {
		available: true,
		label: 'TVA non applicable, art. 293 B du CGI (Franchise en base de TVA).'
	},
	layoutStandard: 'generic',
	vatIdPattern: /^FR[A-Z0-9]{2}\d{9}$/,
	vatIdLabel: 'N° TVA',
	taxIdLabel: 'SIREN/SIRET',
	dateLocale: 'fr-FR',
	numberLocale: 'fr-FR',
	// Art. L102 B LPF requires 6 years; we conservatively hold to a 10-year
	// window to match the GoBD baseline until an operator overrides it.
	retentionYears: 10
};

export default profile;
