/**
 * PDF invoice generator using pdf-lib.
 * Supports multiple languages and legal profiles.
 */

import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from 'pdf-lib';
import { fmtDate, fmtNumber, type InvoicePdfData } from './invoice-pdf';
import { translationsFor } from '$lib/i18n';
import { getLegalProfile } from '$lib/legal';
import { formatCents } from '$lib/shared/money';

// -- A4 dimensions & margins (mm) --
const PW = 210;
const PH = 297;
const ML = 25;
const MR = 25;
const MT = 20;
const CW = PW - ML - MR;

// -- Colors --
const C = {
	accent: rgb(37 / 255, 99 / 255, 235 / 255),
	text: rgb(26 / 255, 26 / 255, 26 / 255),
	dark: rgb(34 / 255, 34 / 255, 34 / 255),
	gray: rgb(85 / 255, 85 / 255, 85 / 255),
	gray2: rgb(51 / 255, 51 / 255, 51 / 255),
	light: rgb(136 / 255, 136 / 255, 136 / 255),
	lighter: rgb(119 / 255, 119 / 255, 119 / 255),
	muted: rgb(153 / 255, 153 / 255, 153 / 255),
	border: rgb(224 / 255, 224 / 255, 224 / 255),
	borderLight: rgb(232 / 255, 232 / 255, 232 / 255),
	bgLight: rgb(250 / 255, 250 / 255, 250 / 255),
	headerBorder: rgb(204 / 255, 204 / 255, 204 / 255),
	summary: rgb(68 / 255, 68 / 255, 68 / 255)
};

function mm2pt(mm: number): number {
	return mm * 2.83465;
}

function yPt(yMm: number): number {
	return mm2pt(PH - yMm);
}

function textWidthMm(text: string, font: PDFFont, sizePt: number): number {
	return font.widthOfTextAtSize(text, sizePt) * 0.3528;
}

function splitText(text: string, font: PDFFont, sizePt: number, maxWidthMm: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const test = current ? `${current} ${word}` : word;
		if (textWidthMm(test, font, sizePt) > maxWidthMm && current) {
			lines.push(current);
			current = word;
		} else {
			current = test;
		}
	}
	if (current) lines.push(current);
	if (lines.length === 0) lines.push('');
	return lines;
}

function drawText(page: PDFPage, text: string, xMm: number, yMm: number, font: PDFFont, sizePt: number, color: ReturnType<typeof rgb>) {
	page.drawText(text, { x: mm2pt(xMm), y: yPt(yMm), size: sizePt, font, color });
}

function drawTextRight(page: PDFPage, text: string, xRightMm: number, yMm: number, font: PDFFont, sizePt: number, color: ReturnType<typeof rgb>) {
	const w = textWidthMm(text, font, sizePt);
	drawText(page, text, xRightMm - w, yMm, font, sizePt, color);
}

function drawRect(page: PDFPage, xMm: number, yMm: number, wMm: number, hMm: number, color: ReturnType<typeof rgb>) {
	page.drawRectangle({ x: mm2pt(xMm), y: yPt(yMm + hMm), width: mm2pt(wMm), height: mm2pt(hMm), color });
}

function drawLine(page: PDFPage, x1Mm: number, yMm: number, x2Mm: number, color: ReturnType<typeof rgb>, widthPt = 0.5) {
	page.drawLine({ start: { x: mm2pt(x1Mm), y: yPt(yMm) }, end: { x: mm2pt(x2Mm), y: yPt(yMm) }, thickness: widthPt, color });
}

export async function createInvoicePdf(data: InvoicePdfData): Promise<Uint8Array> {
	const locale = data.language || 'de';
	const legalCountry = data.legalCountry || 'DE';
	const profile = getLegalProfile(legalCountry);
	const tr = translationsFor(locale).pdf;
	const dateLocale = profile.dateLocale;
	const numberLocale = profile.numberLocale;
	const showDeliveryDate = profile.requiredPdfFields.includes('deliveryDate');

	const pdfDoc = await PDFDocument.create();
	const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
	const page = pdfDoc.addPage([mm2pt(PW), mm2pt(PH)]);

	let y = MT;

	// Accent line
	drawRect(page, 0, 0, PW, 1, C.accent);
	y += 2;

	// Sender line
	const senderLine = `${data.issuerName} \u00b7 ${data.issuerAddress}`;
	drawText(page, senderLine, ML, y, font, 5.25, C.lighter);
	drawLine(page, ML, y + 1, ML + 85, C.headerBorder, 0.35);
	y += 4;

	// Address area
	const recipientStartY = y;
	drawText(page, data.recipientName, ML, y, fontBold, 8.25, C.text);
	y += 3.5;

	const addrParts = data.recipientAddress.split(',').map((p) => p.trim()).filter(Boolean);
	for (const part of addrParts) {
		drawText(page, part, ML, y, font, 7.1, C.gray2);
		y += 3;
	}

	// Issuer info (right)
	const issuerRight = PW - MR;
	let iy = recipientStartY;
	const issuerParts = [
		data.issuerName,
		...data.issuerAddress.split(',').map((p) => p.trim()),
		'',
		data.issuerPhone ? `${tr.tel} ${data.issuerPhone}` : '',
		data.issuerEmail,
		data.issuerWebsite
	].filter((p) => p !== undefined);

	for (const part of issuerParts) {
		if (part === '') { iy += 2; continue; }
		drawTextRight(page, part, issuerRight, iy, font, 6.4, C.gray);
		iy += 2.8;
	}

	y = Math.max(y, iy) + 8;

	// Invoice title
	drawText(page, `${tr.invoiceTitle} ${data.invoiceNumber}`, ML, y, fontBold, 16.5, C.text);
	y += 8;

	// Meta grid
	const metaItems: Array<{ label: string; value: string }> = [
		{ label: tr.invoiceDate.toUpperCase(), value: fmtDate(data.issueDate, dateLocale) }
	];
	if (showDeliveryDate) {
		metaItems.push({ label: tr.deliveryDate.toUpperCase(), value: fmtDate(data.deliveryDate || data.issueDate, dateLocale) });
	}
	metaItems.push({ label: tr.dueDate.toUpperCase(), value: fmtDate(data.dueDate, dateLocale) });
	if (data.servicePeriodStart && data.servicePeriodEnd) {
		metaItems.push({ label: tr.servicePeriod.toUpperCase(), value: `${fmtDate(data.servicePeriodStart, dateLocale)} \u2013 ${fmtDate(data.servicePeriodEnd, dateLocale)}` });
	}
	if (data.overdueCharge > 0) {
		metaItems.push({ label: tr.overdueInterest.toUpperCase(), value: `${data.overdueCharge} % p.a.` });
	}

	const metaH = 11;
	drawRect(page, ML, y - 1, CW, metaH, C.bgLight);
	drawLine(page, ML, y - 1, ML + CW, C.borderLight, 0.35);
	drawLine(page, ML, y - 1 + metaH, ML + CW, C.borderLight, 0.35);

	let mx = ML + 5;
	const metaGap = 22;
	for (const item of metaItems) {
		const neededWidth = Math.max(textWidthMm(item.label, fontBold, 5.25), textWidthMm(item.value, font, 7.1)) + 5;
		if (mx + neededWidth > PW - MR - 5) mx = ML + 5;
		drawText(page, item.label, mx, y + 1.5, fontBold, 5.25, C.light);
		drawText(page, item.value, mx, y + 5, font, 7.1, C.text);
		mx += Math.max(neededWidth, metaGap);
	}
	y += metaH + 2;

	const deliveryDateStr = data.deliveryDate || data.issueDate;
	if (showDeliveryDate && deliveryDateStr === data.issueDate) {
		drawText(page, tr.deliveryDateEqualsInvoice, ML, y, font, 6, C.light);
		y += 3;
	}
	y += 3;

	// Items table
	const colW = { pos: CW * 0.04, desc: CW * 0.36, qty: CW * 0.08, unit: CW * 0.08, price: CW * 0.15, tax: CW * 0.1, total: CW * 0.19 };
	const colX = {
		pos: ML, desc: ML + colW.pos, qty: ML + colW.pos + colW.desc,
		unit: ML + colW.pos + colW.desc + colW.qty,
		price: ML + colW.pos + colW.desc + colW.qty + colW.unit,
		tax: ML + colW.pos + colW.desc + colW.qty + colW.unit + colW.price,
		total: ML + colW.pos + colW.desc + colW.qty + colW.unit + colW.price + colW.tax
	};

	const thSize = 5.6;
	drawText(page, '#', colX.pos + 1, y, fontBold, thSize, C.gray);
	drawText(page, tr.description.toUpperCase(), colX.desc + 2, y, fontBold, thSize, C.gray);
	drawTextRight(page, tr.quantity.toUpperCase(), colX.qty + colW.qty - 1, y, fontBold, thSize, C.gray);
	drawText(page, tr.unit.toUpperCase(), colX.unit + 2, y, fontBold, thSize, C.gray);
	drawTextRight(page, tr.unitPrice.toUpperCase(), colX.price + colW.price - 1, y, fontBold, thSize, C.gray);
	drawTextRight(page, tr.vat.toUpperCase(), colX.tax + colW.tax - 1, y, fontBold, thSize, C.gray);
	drawTextRight(page, tr.total.toUpperCase(), colX.total + colW.total - 1, y, fontBold, thSize, C.gray);
	y += 2;
	drawLine(page, ML, y, ML + CW, C.text, 1);
	y += 3;

	const tdSize = 6.75;
	for (let i = 0; i < data.items.length; i++) {
		const item = data.items[i];
		const descLines = splitText(item.description, font, tdSize, colW.desc - 3);
		const rowH = Math.max(descLines.length * 3.2, 5);

		drawText(page, String(item.position), colX.pos + 1, y, font, tdSize, C.muted);
		for (let li = 0; li < descLines.length; li++) {
			drawText(page, descLines[li], colX.desc + 2, y + li * 3.2, font, tdSize, C.dark);
		}
		drawTextRight(page, fmtNumber(item.quantity, numberLocale), colX.qty + colW.qty - 1, y, font, tdSize, C.dark);
		drawText(page, item.unit, colX.unit + 2, y, font, tdSize, C.dark);
		drawTextRight(page, formatCents(item.unitPriceNetCents, numberLocale, data.currency), colX.price + colW.price - 1, y, font, tdSize, C.dark);
		drawTextRight(page, `${item.taxRate.toFixed(0)} %`, colX.tax + colW.tax - 1, y, font, tdSize, C.dark);
		drawTextRight(page, formatCents(item.lineTotalNetCents, numberLocale, data.currency), colX.total + colW.total - 1, y, fontBold, tdSize, C.dark);

		y += rowH;
		const borderW = i === data.items.length - 1 ? 1 : 0.35;
		const borderC = i === data.items.length - 1 ? C.text : C.border;
		drawLine(page, ML, y, ML + CW, borderC, borderW);
		y += 2;
	}

	y += 3;

	// Bottom: notes + summary
	const leftW = CW * 0.48;
	const rightX = ML + CW * 0.52;
	const rightW = CW * 0.48;

	let notesY = y;
	if (data.notes) {
		drawText(page, tr.notes.toUpperCase(), ML, notesY, fontBold, 5.25, C.light);
		notesY += 3;
		const noteLines = splitText(data.notes, font, 6.4, leftW - 10);
		for (const line of noteLines) {
			drawText(page, line, ML, notesY, font, 6.4, C.gray);
			notesY += 2.8;
		}
	}

	if (data.dueDate) {
		notesY += 2;
		const paymentText = tr.payableBefore.replace('{date}', fmtDate(data.dueDate, dateLocale));
		drawText(page, paymentText, ML, notesY, fontBold, 7.1, C.text);
		notesY += 4;
	}

	// Summary (right)
	let sumY = y;
	const sumSize = 6.75;
	for (const g of data.taxGroups) {
		drawText(page, `${tr.netAmount} ${g.rate.toFixed(0)} %`, rightX, sumY, font, sumSize, C.summary);
		drawTextRight(page, formatCents(g.netAmountCents, numberLocale, data.currency), rightX + rightW, sumY, font, sumSize, C.summary);
		sumY += 3;
		drawText(page, `${tr.vat} ${g.rate.toFixed(0)} %`, rightX, sumY, font, sumSize, C.summary);
		drawTextRight(page, formatCents(g.amountCents, numberLocale, data.currency), rightX + rightW, sumY, font, sumSize, C.summary);
		sumY += 3;
	}

	sumY += 1;
	drawLine(page, rightX, sumY, rightX + rightW, C.text, 1);
	sumY += 3;
	drawText(page, tr.grossTotal, rightX, sumY, fontBold, 9, C.text);
	drawTextRight(page, formatCents(data.totalCents, numberLocale, data.currency), rightX + rightW, sumY, fontBold, 9, C.text);
	sumY += 5;

	y = Math.max(notesY, sumY) + 2;

	// Bank info
	if (data.issuerBankIban) {
		const bankH = 14;
		drawRect(page, ML, y, CW, bankH, C.bgLight);
		drawLine(page, ML, y, ML + CW, C.borderLight, 0.35);
		drawLine(page, ML, y + bankH, ML + CW, C.borderLight, 0.35);

		let by = y + 2.5;
		drawText(page, tr.bankDetails.toUpperCase(), ML + 4, by, fontBold, 5.25, C.light);
		by += 3.2;

		const bankRows: Array<[string, string]> = [];
		if (data.issuerBankAccountHolder) bankRows.push([tr.accountHolder, data.issuerBankAccountHolder]);
		if (data.issuerBankName) bankRows.push([tr.bank, data.issuerBankName]);
		bankRows.push(['IBAN', data.issuerBankIban]);
		if (data.issuerBankBic) bankRows.push(['BIC', data.issuerBankBic]);

		for (const [label, value] of bankRows) {
			drawText(page, label, ML + 4, by, font, 6.4, C.light);
			drawText(page, value, ML + 18, by, font, 6.4, C.gray);
			by += 2.8;
		}
	}

	// Footer
	const footerY = PH - 15;
	drawLine(page, ML, footerY - 3, ML + CW, C.headerBorder, 0.35);

	const fSize = 5.25;
	const col1X = ML;
	const col2X = ML + CW / 3;

	const f1Parts = [data.issuerName, ...data.issuerAddress.split(',').map((p) => p.trim()), data.issuerPhone ? `${tr.tel} ${data.issuerPhone}` : '', data.issuerEmail].filter(Boolean);
	let fy = footerY;
	for (const p of f1Parts) { drawText(page, p, col1X, fy, font, fSize, C.light); fy += 2.2; }

	const f2Parts = [data.issuerBankAccountHolder ? `${tr.accountHolderFull} ${data.issuerBankAccountHolder}` : '', data.issuerBankName, data.issuerBankIban ? `IBAN ${data.issuerBankIban}` : '', data.issuerBankBic ? `BIC ${data.issuerBankBic}` : ''].filter(Boolean);
	fy = footerY;
	const colWidth = CW / 3;
	for (const p of f2Parts) { const tw = textWidthMm(p, font, fSize); drawText(page, p, col2X + (colWidth - tw) / 2, fy, font, fSize, C.light); fy += 2.2; }

	const f3Parts = [data.issuerVatId ? `${profile.vatIdLabel} ${data.issuerVatId}` : '', data.issuerTaxNumber && profile.requiredPdfFields.includes('taxId') ? `${profile.taxIdLabel} ${data.issuerTaxNumber}` : '', data.issuerWebsite || ''].filter(Boolean);
	fy = footerY;
	for (const p of f3Parts) { drawTextRight(page, p, PW - MR, fy, font, fSize, C.light); fy += 2.2; }

	const pdfBytes = await pdfDoc.save();
	return new Uint8Array(pdfBytes);
}
