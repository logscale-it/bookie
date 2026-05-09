/**
 * Generates a printable HTML invoice document.
 * Supports multiple languages and legal profiles.
 * DIN 5008 compliant layout for German business correspondence, generic layout for others.
 *
 * Money fields on `InvoicePdfData` are integer cents (minor currency units).
 * All amounts are rendered through `formatCents` from `$lib/shared/money`,
 * matching the storage format introduced by migration 0015 (DAT-1.a).
 */

import { translationsFor, type Locale } from '$lib/i18n';
import { getLegalProfile, type LegalCountry } from '$lib/legal';
import { formatCents } from '$lib/shared/money';

export interface InvoicePdfData {
	issuerName: string;
	issuerAddress: string;
	issuerTaxNumber: string;
	issuerVatId: string;
	issuerBankAccountHolder: string;
	issuerBankName: string;
	issuerBankIban: string;
	issuerBankBic: string;
	issuerEmail: string;
	issuerWebsite: string;
	issuerPhone: string;
	logoDataUrl: string | null;
	recipientName: string;
	recipientAddress: string;
	invoiceNumber: string;
	issueDate: string;
	dueDate: string;
	deliveryDate: string;
	overdueCharge: number;
	servicePeriodStart: string;
	servicePeriodEnd: string;
	currency: string;
	notes: string;
	language: Locale;
	legalCountry: LegalCountry;
	items: Array<{
		position: number;
		description: string;
		quantity: number;
		unit: string;
		unitPriceNetCents: number;
		taxRate: number;
		lineTotalNetCents: number;
	}>;
	subtotalCents: number;
	taxGroups: Array<{
		label: string;
		rate: number;
		netAmountCents: number;
		amountCents: number;
	}>;
	totalCents: number;
}

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function fmtDate(dateStr: string, locale: string = 'de-DE'): string {
	if (!dateStr) return '';
	const [y, m, d] = dateStr.split('-');
	if (locale.startsWith('en')) return `${m}/${d}/${y}`;
	if (locale.startsWith('fr')) return `${d}/${m}/${y}`;
	return `${d}.${m}.${y}`;
}

export function fmtNumber(n: number, locale: string = 'de-DE'): string {
	return new Intl.NumberFormat(locale).format(n);
}

export function generateInvoiceHtml(data: InvoicePdfData): string {
	const locale = data.language || 'de';
	const legalCountry = data.legalCountry || 'DE';
	const profile = getLegalProfile(legalCountry);
	const tr = translationsFor(locale).pdf;
	const dateLocale = profile.dateLocale;
	const numberLocale = profile.numberLocale;

	const itemRows = data.items
		.map(
			(item) => `
		<tr>
			<td class="pos">${item.position}</td>
			<td class="desc">${esc(item.description)}</td>
			<td class="qty">${fmtNumber(item.quantity, numberLocale)}</td>
			<td class="unit">${esc(item.unit)}</td>
			<td class="price">${formatCents(item.unitPriceNetCents, numberLocale, data.currency)}</td>
			<td class="tax">${item.taxRate.toFixed(0)} %</td>
			<td class="total">${formatCents(item.lineTotalNetCents, numberLocale, data.currency)}</td>
		</tr>`
		)
		.join('');

	const taxRows = data.taxGroups
		.map(
			(g) => `
		<div class="summary-row">
			<span>${esc(tr.netAmount)} ${g.rate.toFixed(0)} %</span>
			<span>${formatCents(g.netAmountCents, numberLocale, data.currency)}</span>
		</div>
		<div class="summary-row">
			<span>${esc(tr.vat)} ${g.rate.toFixed(0)} %</span>
			<span>${formatCents(g.amountCents, numberLocale, data.currency)}</span>
		</div>`
		)
		.join('');

	const showDeliveryDate = profile.requiredPdfFields.includes('deliveryDate');

	const servicePeriod =
		data.servicePeriodStart && data.servicePeriodEnd
			? `<div class="meta-item"><span class="meta-label">${esc(tr.servicePeriod)}</span><span class="meta-value">${fmtDate(data.servicePeriodStart, dateLocale)} – ${fmtDate(data.servicePeriodEnd, dateLocale)}</span></div>`
			: '';

	const overdueRow =
		data.overdueCharge > 0
			? `<div class="meta-item"><span class="meta-label">${esc(tr.overdueInterest)}</span><span class="meta-value">${data.overdueCharge} % p.a.</span></div>`
			: '';

	const logoHtml = data.logoDataUrl ? `<img src="${data.logoDataUrl}" class="logo" />` : '';

	const senderLine = `${esc(data.issuerName)} · ${esc(data.issuerAddress)}`;

	const deliveryDateStr = data.deliveryDate || data.issueDate;
	const deliveryDateNote =
		showDeliveryDate && deliveryDateStr === data.issueDate
			? `<div class="delivery-note">${esc(tr.deliveryDateEqualsInvoice)}</div>`
			: '';

	const paymentTerms = data.dueDate
		? esc(tr.payableBefore.replace('{date}', fmtDate(data.dueDate, dateLocale)))
		: '';

	const legalNotices: string[] = [];
	if (tr.reverseCharge) legalNotices.push(tr.reverseCharge);
	if (tr.smallBusiness) legalNotices.push(tr.smallBusiness);

	const footerCol1Parts = [
		data.issuerName,
		...data.issuerAddress.split(',').map((s) => s.trim()),
		data.issuerPhone ? `${tr.tel} ${data.issuerPhone}` : '',
		data.issuerEmail
	].filter(Boolean);

	const footerCol2Parts = [
		data.issuerBankAccountHolder ? `${tr.accountHolderFull} ${data.issuerBankAccountHolder}` : '',
		data.issuerBankName,
		data.issuerBankIban ? `IBAN ${data.issuerBankIban}` : '',
		data.issuerBankBic ? `BIC ${data.issuerBankBic}` : ''
	].filter(Boolean);

	const footerCol3Parts = [
		data.issuerVatId ? `${profile.vatIdLabel} ${data.issuerVatId}` : '',
		data.issuerTaxNumber && profile.requiredPdfFields.includes('taxId')
			? `${profile.taxIdLabel} ${data.issuerTaxNumber}`
			: '',
		data.issuerWebsite || ''
	].filter(Boolean);

	const footerCol = (parts: string[]) => parts.map((p) => `<div>${esc(p)}</div>`).join('');

	const issuerInfoParts = [
		data.issuerName,
		...data.issuerAddress.split(',').map((s) => s.trim()),
		'',
		data.issuerPhone ? `${tr.tel} ${data.issuerPhone}` : '',
		data.issuerEmail,
		data.issuerWebsite
	].filter((p) => p !== undefined);

	const issuerInfoHtml = issuerInfoParts
		.map((p) => (p === '' ? '<br/>' : `<div>${esc(p)}</div>`))
		.join('');

	const htmlLang = locale === 'de' ? 'de' : 'en';

	return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8"/>
<title>${esc(tr.invoiceTitle)} ${esc(data.invoiceNumber)}</title>
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

@page { size: A4; margin: 0; }

body {
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	font-size: 9.5px; line-height: 1.55; color: #1a1a1a; background: #fff;
	-webkit-print-color-adjust: exact; print-color-adjust: exact;
}

.page { width: 210mm; min-height: 297mm; padding: 20mm 25mm 28mm 25mm; position: relative; page-break-after: always; }
.accent-line { position: absolute; top: 0; left: 0; right: 0; height: 3px; background: #2563eb; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8mm; }
.header-left { flex: 1; }
.logo { max-width: 160px; max-height: 55px; object-fit: contain; }
.sender-line { font-size: 7px; color: #777; border-bottom: 0.5px solid #bbb; padding-bottom: 2px; margin-bottom: 3mm; letter-spacing: 0.02em; }
.address-area { display: flex; justify-content: space-between; margin-bottom: 12mm; }
.recipient-block { width: 85mm; }
.recipient-block .address-name { font-size: 11px; font-weight: 600; margin-bottom: 2px; color: #1a1a1a; }
.recipient-block .address-detail { font-size: 9.5px; color: #333; line-height: 1.65; }
.issuer-info { text-align: right; font-size: 8.5px; color: #555; line-height: 1.6; }
.invoice-title { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 6mm; letter-spacing: -0.03em; }
.meta { display: flex; flex-wrap: wrap; gap: 7mm; margin-bottom: 8mm; padding: 4mm 5mm; background: #fafafa; border-radius: 3px; border: 0.5px solid #e8e8e8; }
.meta-item { display: flex; flex-direction: column; min-width: 75px; }
.meta-label { font-size: 7px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 1px; }
.meta-value { font-size: 9.5px; font-weight: 500; color: #1a1a1a; }
.delivery-note { font-size: 8px; color: #888; font-style: italic; margin-top: 2mm; }
table { width: 100%; border-collapse: collapse; margin-bottom: 2mm; }
thead tr { border-bottom: 1.5px solid #1a1a1a; }
th { font-size: 7.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 7px 8px; color: #555; }
th:first-child { padding-left: 0; } th:last-child { padding-right: 0; text-align: right; }
td { font-size: 9px; padding: 8px 8px; border-bottom: 0.5px solid #e0e0e0; vertical-align: top; color: #222; }
td:first-child { padding-left: 0; } td:last-child { padding-right: 0; }
tr:last-child td { border-bottom: 1.5px solid #1a1a1a; }
.pos { width: 4%; color: #999; } .desc { width: 36%; } .qty { width: 8%; text-align: right; }
.unit { width: 8%; } .price { width: 15%; text-align: right; } .tax { width: 10%; text-align: right; }
.total { width: 19%; text-align: right; font-weight: 500; }
th.qty, th.price, th.tax, th.total { text-align: right; }
.bottom { display: flex; justify-content: space-between; margin-top: 5mm; }
.notes-section { width: 48%; font-size: 8.5px; color: #555; padding-right: 10mm; white-space: pre-wrap; line-height: 1.65; }
.notes-label { font-size: 7px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 3px; }
.payment-terms { margin-top: 4mm; font-size: 9.5px; font-weight: 500; color: #1a1a1a; }
.legal-notice { margin-top: 3mm; font-size: 8px; color: #666; font-style: italic; }
.summary { width: 48%; }
.summary-row { display: flex; justify-content: space-between; padding: 2.5px 0; font-size: 9px; color: #444; }
.summary-divider { border-top: 1.5px solid #1a1a1a; margin-top: 6px; padding-top: 6px; }
.summary-total { font-weight: 700; font-size: 12px; color: #1a1a1a; }
.bank-info { margin-top: 6mm; padding: 3mm 4mm; background: #fafafa; border: 0.5px solid #e8e8e8; border-radius: 3px; font-size: 8.5px; color: #555; line-height: 1.6; }
.bank-info-label { font-size: 7px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 2px; }
.bank-info-row { display: flex; gap: 12px; }
.bank-info-row span:first-child { color: #888; min-width: 35px; }
.footer { position: absolute; bottom: 15mm; left: 25mm; right: 25mm; border-top: 0.5px solid #ccc; padding-top: 3mm; display: flex; justify-content: space-between; font-size: 7px; color: #888; line-height: 1.6; }
.footer-col { flex: 1; }
.footer-col:nth-child(2) { text-align: center; }
.footer-col:nth-child(3) { text-align: right; }

@media print { body { background: #fff; } .page { padding: 20mm 25mm 28mm 25mm; width: 100%; min-height: auto; } }
</style>
</head>
<body>
<div class="page">
	<div class="accent-line"></div>

	<div class="header">
		<div class="header-left"></div>
		${logoHtml}
	</div>

	<div class="address-area">
		<div class="recipient-block">
			<div class="sender-line">${senderLine}</div>
			<div class="address-name">${esc(data.recipientName)}</div>
			<div class="address-detail">${esc(data.recipientAddress).replace(/,\s*/g, '<br/>')}</div>
		</div>
		<div class="issuer-info">
			${issuerInfoHtml}
		</div>
	</div>

	<div class="invoice-title">${esc(tr.invoiceTitle)} ${esc(data.invoiceNumber)}</div>

	<div class="meta">
		<div class="meta-item">
			<span class="meta-label">${esc(tr.invoiceDate)}</span>
			<span class="meta-value">${fmtDate(data.issueDate, dateLocale)}</span>
		</div>
		${showDeliveryDate ? `<div class="meta-item"><span class="meta-label">${esc(tr.deliveryDate)}</span><span class="meta-value">${fmtDate(deliveryDateStr, dateLocale)}</span></div>` : ''}
		<div class="meta-item">
			<span class="meta-label">${esc(tr.dueDate)}</span>
			<span class="meta-value">${fmtDate(data.dueDate, dateLocale)}</span>
		</div>
		${servicePeriod}
		${overdueRow}
	</div>
	${deliveryDateNote}

	<table>
		<thead>
			<tr>
				<th class="pos">#</th>
				<th class="desc">${esc(tr.description)}</th>
				<th class="qty">${esc(tr.quantity)}</th>
				<th class="unit">${esc(tr.unit)}</th>
				<th class="price">${esc(tr.unitPrice)}</th>
				<th class="tax">${esc(tr.vat)}</th>
				<th class="total">${esc(tr.total)}</th>
			</tr>
		</thead>
		<tbody>
			${itemRows}
		</tbody>
	</table>

	<div class="bottom">
		<div class="notes-section">
			${data.notes ? `<div class="notes-label">${esc(tr.notes)}</div><div>${esc(data.notes)}</div>` : ''}
			${paymentTerms ? `<div class="payment-terms">${paymentTerms}</div>` : ''}
			${legalNotices.map((n) => `<div class="legal-notice">${esc(n)}</div>`).join('')}
		</div>
		<div class="summary">
			${taxRows}
			<div class="summary-divider">
				<div class="summary-row summary-total">
					<span>${esc(tr.grossTotal)}</span>
					<span>${formatCents(data.totalCents, numberLocale, data.currency)}</span>
				</div>
			</div>
		</div>
	</div>

	${data.issuerBankIban ? `
	<div class="bank-info">
		<div class="bank-info-label">${esc(tr.bankDetails)}</div>
		${data.issuerBankAccountHolder ? `<div class="bank-info-row"><span>${esc(tr.accountHolder)}</span><span>${esc(data.issuerBankAccountHolder)}</span></div>` : ''}
		${data.issuerBankName ? `<div class="bank-info-row"><span>${esc(tr.bank)}</span><span>${esc(data.issuerBankName)}</span></div>` : ''}
		<div class="bank-info-row"><span>IBAN</span><span>${esc(data.issuerBankIban)}</span></div>
		${data.issuerBankBic ? `<div class="bank-info-row"><span>BIC</span><span>${esc(data.issuerBankBic)}</span></div>` : ''}
	</div>
	` : ''}

	<div class="footer">
		<div class="footer-col">${footerCol(footerCol1Parts)}</div>
		<div class="footer-col">${footerCol(footerCol2Parts)}</div>
		<div class="footer-col">${footerCol(footerCol3Parts)}</div>
	</div>
</div>
</body>
</html>`;
}
