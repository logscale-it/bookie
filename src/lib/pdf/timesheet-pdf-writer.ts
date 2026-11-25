/**
 * Binary PDF generator for timesheets (Stundenzettel) using pdf-lib.
 * A4 layout with Helvetica font, matching the invoice PDF style.
 */

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import { translations } from '$lib/i18n';

export type TimeSheetPdfGroupEntry = {
	entryDate: string;
	description: string;
	durationLabel: string;
};

export type TimeSheetPdfGroup = {
	customerName: string;
	periodLabel: string;
	totalLabel: string;
	entries: TimeSheetPdfGroupEntry[];
};

export type TimeSheetPdfData = {
	createdAtLabel: string;
	filtersLabel: string;
	totalHoursLabel: string;
	groups: TimeSheetPdfGroup[];
};

// -- A4 dimensions & margins (mm) --
const PW = 210;
const PH = 297;
const ML = 25;
const MR = 25;
const MT = 20;
const MB = 20;
const CW = PW - ML - MR;

// -- Colors --
const C = {
	text: rgb(26 / 255, 26 / 255, 26 / 255),
	gray: rgb(85 / 255, 85 / 255, 85 / 255),
	light: rgb(136 / 255, 136 / 255, 136 / 255),
	border: rgb(224 / 255, 224 / 255, 224 / 255),
	borderLight: rgb(232 / 255, 232 / 255, 232 / 255),
	bgLight: rgb(250 / 255, 250 / 255, 250 / 255),
	headerBorder: rgb(204 / 255, 204 / 255, 204 / 255)
};

// -- Column layout --
const COL_DATE_W = 30;
const COL_DUR_W = 25;
const COL_DESC_W = CW - COL_DATE_W - COL_DUR_W;
const COL_DATE_X = ML;
const COL_DESC_X = ML + COL_DATE_W;
const COL_DUR_X = ML + COL_DATE_W + COL_DESC_W;

// -- Font sizes --
const FS = { title: 16.5, groupName: 8.25, groupPeriod: 6.4, metaLabel: 5.25, metaValue: 6.4, thSize: 5.6, tdSize: 6.75, sumSize: 7 };
const ROW_LINE_H = 3.2;
const ROW_PAD = 2;
// y is a row's top edge; text is drawn on a baseline this far below it.
const ROW_BASE = 3.2;

function mm2pt(mm: number): number { return mm * 2.83465; }
function yPt(yMm: number): number { return mm2pt(PH - yMm); }
function textWidthMm(text: string, font: PDFFont, sizePt: number): number { return font.widthOfTextAtSize(text, sizePt) * 0.3528; }

function splitText(text: string, font: PDFFont, sizePt: number, maxWidthMm: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const test = current ? `${current} ${word}` : word;
		if (textWidthMm(test, font, sizePt) > maxWidthMm && current) { lines.push(current); current = word; }
		else { current = test; }
	}
	if (current) lines.push(current);
	if (lines.length === 0) lines.push('');
	return lines;
}

function drawText(page: PDFPage, text: string, xMm: number, yMm: number, font: PDFFont, sizePt: number, color: ReturnType<typeof rgb>) {
	page.drawText(text, { x: mm2pt(xMm), y: yPt(yMm), size: sizePt, font, color });
}

function drawTextRight(page: PDFPage, text: string, xRightMm: number, yMm: number, font: PDFFont, sizePt: number, color: ReturnType<typeof rgb>) {
	drawText(page, text, xRightMm - textWidthMm(text, font, sizePt), yMm, font, sizePt, color);
}

function drawRect(page: PDFPage, xMm: number, yMm: number, wMm: number, hMm: number, color: ReturnType<typeof rgb>) {
	page.drawRectangle({ x: mm2pt(xMm), y: yPt(yMm + hMm), width: mm2pt(wMm), height: mm2pt(hMm), color });
}

function drawLine(page: PDFPage, x1Mm: number, yMm: number, x2Mm: number, color: ReturnType<typeof rgb>, widthPt = 0.5) {
	page.drawLine({ start: { x: mm2pt(x1Mm), y: yPt(yMm) }, end: { x: mm2pt(x2Mm), y: yPt(yMm) }, thickness: widthPt, color });
}

export async function createTimesheetPdf(data: TimeSheetPdfData): Promise<Uint8Array> {
	const tr = translations().pdf;
	const pdfDoc = await PDFDocument.create();
	const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

	let page = pdfDoc.addPage([mm2pt(PW), mm2pt(PH)]);
	let y = MT;

	function needsNewPage(requiredMm: number): boolean { return y + requiredMm > PH - MB; }

	function addNewPage() {
		page = pdfDoc.addPage([mm2pt(PW), mm2pt(PH)]);
		y = MT;
	}

	function drawTableHeader() {
		drawText(page, tr.timesheetDate.toUpperCase(), COL_DATE_X, y, fontBold, FS.thSize, C.gray);
		drawText(page, tr.timesheetDescription.toUpperCase(), COL_DESC_X, y, fontBold, FS.thSize, C.gray);
		drawTextRight(page, tr.timesheetDuration.toUpperCase(), COL_DUR_X + COL_DUR_W, y, fontBold, FS.thSize, C.gray);
		y += 2;
		drawLine(page, ML, y, ML + CW, C.text, 0.75);
	}

	y += 2;

	// -- Title --
	drawText(page, tr.timesheetTitle, ML, y, fontBold, FS.title, C.text);
	y += 8;

	// -- Metadata block --
	const metaH = 11;
	drawRect(page, ML, y - 1, CW, metaH, C.bgLight);
	drawLine(page, ML, y - 1, ML + CW, C.borderLight, 0.35);
	drawLine(page, ML, y - 1 + metaH, ML + CW, C.borderLight, 0.35);

	const metaItems = [
		{ label: tr.timesheetCreated.toUpperCase(), value: data.createdAtLabel },
		{ label: tr.timesheetTotalDuration.toUpperCase(), value: data.totalHoursLabel }
	];

	let my = y + 3.8;
	for (const item of metaItems) {
		drawText(page, item.label, ML + 4, my, fontBold, FS.metaLabel, C.light);
		drawText(page, item.value, ML + 30, my, font, FS.metaValue, C.text);
		my += 3.5;
	}
	y += metaH + 4;

	// -- Empty state --
	if (data.groups.length === 0) {
		drawText(page, tr.timesheetNoEntries, ML, y, font, FS.tdSize, C.gray);
		return new Uint8Array(await pdfDoc.save());
	}

	// -- Groups --
	for (const group of data.groups) {
		// Estimate min height: header(8) + table header(6) + 1 row(5) + total(6) = ~25mm
		if (needsNewPage(25)) addNewPage();

		// Group header
		drawText(page, group.customerName, ML, y, fontBold, FS.groupName, C.text);
		y += 3.5;
		drawText(page, group.periodLabel, ML, y, font, FS.groupPeriod, C.gray);
		y += 4;

		// Table header
		drawTableHeader();

		// Table rows
		for (const entry of group.entries) {
			const descLines = splitText(entry.description || '—', font, FS.tdSize, COL_DESC_W - 3);
			const rowH = descLines.length * ROW_LINE_H + ROW_PAD;

			if (needsNewPage(rowH + 2)) {
				addNewPage();
				drawTableHeader();
			}

			drawText(page, entry.entryDate, COL_DATE_X, y + ROW_BASE, font, FS.tdSize, C.text);
			for (let i = 0; i < descLines.length; i++) {
				drawText(page, descLines[i], COL_DESC_X, y + ROW_BASE + i * ROW_LINE_H, font, FS.tdSize, C.text);
			}
			drawTextRight(page, entry.durationLabel, COL_DUR_X + COL_DUR_W, y + ROW_BASE, font, FS.tdSize, C.text);

			y += rowH;
			drawLine(page, ML, y, ML + CW, C.border, 0.35);
		}

		// Group total
		if (needsNewPage(6)) addNewPage();
		drawLine(page, ML, y, ML + CW, C.headerBorder, 0.75);
		y += 4.5;
		const sumLabel = `${tr.timesheetSum}: ${group.totalLabel}`;
		drawTextRight(page, sumLabel, ML + CW, y, fontBold, FS.sumSize, C.text);
		y += 6;
	}

	return new Uint8Array(await pdfDoc.save());
}
