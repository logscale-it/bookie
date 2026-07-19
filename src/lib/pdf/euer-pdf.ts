/**
 * Binary PDF generator for the EÜR period report (§ 4 Abs. 3 EStG) using
 * pdf-lib. A4 layout with Helvetica, matching the invoice/timesheet PDF
 * style. Labels are fixed German — the EÜR is a German tax document.
 */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFPage,
  type PDFFont,
} from "pdf-lib";
import type { EuerReport } from "$lib/db/tax-reports";

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
  gray: rgb(85 / 255, 85 / 255, 85 / 255),
  light: rgb(136 / 255, 136 / 255, 136 / 255),
  border: rgb(224 / 255, 224 / 255, 224 / 255),
  bgLight: rgb(250 / 255, 250 / 255, 250 / 255),
  headerBorder: rgb(204 / 255, 204 / 255, 204 / 255),
  positive: rgb(5 / 255, 150 / 255, 105 / 255),
  negative: rgb(220 / 255, 38 / 255, 38 / 255),
};

const PRODUCER = "Bookie (pdf-lib)";
const CREATOR = "Bookie";

function mm2pt(mm: number): number {
  return mm * 2.83465;
}
function yPt(yMm: number): number {
  return mm2pt(PH - yMm);
}
function textWidthMm(text: string, font: PDFFont, sizePt: number): number {
  return font.widthOfTextAtSize(text, sizePt) * 0.3528;
}

function formatDeDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function formatEur(n: number): string {
  return `${n.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

export interface EuerPdfOptions {
  companyName: string;
  taxNumber: string;
  /** Injected so tests get deterministic PDF metadata. */
  createdAt: Date;
}

export async function createEuerPdf(
  report: EuerReport,
  opts: EuerPdfOptions,
): Promise<Uint8Array> {
  const periodLabel = `${formatDeDate(report.from)} bis ${formatDeDate(report.to)}`;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Einnahmenüberschussrechnung ${periodLabel}`);
  pdfDoc.setSubject("Einnahmenüberschussrechnung nach § 4 Abs. 3 EStG");
  pdfDoc.setAuthor(opts.companyName);
  pdfDoc.setKeywords(["EÜR", "Einnahmenüberschussrechnung", "EStG"]);
  pdfDoc.setCreator(CREATOR);
  pdfDoc.setProducer(PRODUCER);
  pdfDoc.setCreationDate(opts.createdAt);
  pdfDoc.setModificationDate(opts.createdAt);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([mm2pt(PW), mm2pt(PH)]);

  function drawText(
    text: string,
    xMm: number,
    yMm: number,
    f: PDFFont,
    sizePt: number,
    color: ReturnType<typeof rgb>,
  ) {
    page.drawText(text, {
      x: mm2pt(xMm),
      y: yPt(yMm),
      size: sizePt,
      font: f,
      color,
    });
  }
  function drawTextRight(
    text: string,
    xRightMm: number,
    yMm: number,
    f: PDFFont,
    sizePt: number,
    color: ReturnType<typeof rgb>,
  ) {
    drawText(text, xRightMm - textWidthMm(text, f, sizePt), yMm, f, sizePt, color);
  }
  function drawRect(
    xMm: number,
    yMm: number,
    wMm: number,
    hMm: number,
    color: ReturnType<typeof rgb>,
  ) {
    page.drawRectangle({
      x: mm2pt(xMm),
      y: yPt(yMm + hMm),
      width: mm2pt(wMm),
      height: mm2pt(hMm),
      color,
    });
  }
  function drawLine(
    x1Mm: number,
    yMm: number,
    x2Mm: number,
    color: ReturnType<typeof rgb>,
    widthPt = 0.5,
  ) {
    page.drawLine({
      start: { x: mm2pt(x1Mm), y: yPt(yMm) },
      end: { x: mm2pt(x2Mm), y: yPt(yMm) },
      thickness: widthPt,
      color,
    });
  }

  let y = MT;

  // -- Accent bar --
  drawRect(0, 0, PW, 1.2, C.accent);
  y += 4;

  // -- Title --
  drawText("Einnahmenüberschussrechnung", ML, y, fontBold, 16.5, C.text);
  y += 6.5;
  drawText(
    "Gewinnermittlung nach § 4 Abs. 3 EStG",
    ML,
    y,
    font,
    8.5,
    C.gray,
  );
  y += 8;

  // -- Metadata block --
  const metaH = 17;
  drawRect(ML, y - 1, CW, metaH, C.bgLight);
  drawLine(ML, y - 1, ML + CW, C.border, 0.35);
  drawLine(ML, y - 1 + metaH, ML + CW, C.border, 0.35);

  const col2 = ML + CW / 2;
  const metaPairs: [string, string, number][] = [
    ["UNTERNEHMEN", opts.companyName, ML + 4],
    ["ZEITRAUM", periodLabel, col2],
    ["STEUERNUMMER", opts.taxNumber || "—", ML + 4],
    [
      "ERSTELLT AM",
      opts.createdAt.toLocaleDateString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }),
      col2,
    ],
  ];
  for (let i = 0; i < metaPairs.length; i++) {
    const [label, value, x] = metaPairs[i];
    const rowY = y + 2 + Math.floor(i / 2) * 8;
    drawText(label, x, rowY, fontBold, 5.5, C.light);
    drawText(value, x, rowY + 3.5, font, 8, C.text);
  }
  y += metaH + 10;

  // -- Sections --
  function sectionHeader(label: string) {
    drawText(label, ML, y, fontBold, 8, C.gray);
    y += 2;
    drawLine(ML, y, ML + CW, C.text, 0.75);
    y += 5.5;
  }
  function row(label: string, value: number, opts2?: { bold?: boolean }) {
    const f = opts2?.bold ? fontBold : font;
    drawText(label, ML, y, f, 9, C.text);
    drawTextRight(formatEur(value), ML + CW, y, f, 9, C.text);
    y += 6;
  }
  function sumRow(label: string, value: number) {
    drawLine(ML, y - 2, ML + CW, C.headerBorder, 0.75);
    y += 1;
    row(label, value, { bold: true });
  }

  sectionHeader("1. BETRIEBSEINNAHMEN");
  row(
    "Umsatzsteuerpflichtige Betriebseinnahmen (netto)",
    report.incomeTaxableNet,
  );
  row(
    "Umsatzsteuerfreie und nicht steuerbare Betriebseinnahmen",
    report.incomeTaxFreeNet,
  );
  row("Vereinnahmte Umsatzsteuer", report.incomeVat);
  sumRow("Summe Betriebseinnahmen", report.incomeTotal);
  y += 6;

  sectionHeader("2. BETRIEBSAUSGABEN");
  row("Betriebsausgaben (netto)", report.expenseNet);
  row("Gezahlte Vorsteuerbeträge", report.expenseVat);
  sumRow("Summe Betriebsausgaben", report.expenseTotal);
  y += 8;

  // -- Result box --
  const resultH = 13;
  drawRect(ML, y - 1, CW, resultH, C.bgLight);
  drawRect(ML, y - 1, 1.2, resultH, C.accent);
  const resultY = y + 5;
  drawText(
    "Gewinn / Verlust (Einnahmenüberschuss)",
    ML + 5,
    resultY,
    fontBold,
    10.5,
    C.text,
  );
  drawTextRight(
    formatEur(report.profit),
    ML + CW - 4,
    resultY,
    fontBold,
    12,
    report.profit >= 0 ? C.positive : C.negative,
  );
  y += resultH + 10;

  // -- Notes --
  const notes = [
    "Ermittlung nach dem Zufluss-/Abflussprinzip (§ 11 EStG): berücksichtigt sind ausschließlich im",
    "Zeitraum vereinnahmte Betriebseinnahmen und geleistete Betriebsausgaben (bezahlte Rechnungen).",
    "An das Finanzamt gezahlte Umsatzsteuer ist nicht erfasst und ist ggf. manuell als Betriebsausgabe",
    "zu ergänzen.",
  ];
  for (const line of notes) {
    drawText(line, ML, y, font, 6.75, C.light);
    y += 3.2;
  }

  return new Uint8Array(await pdfDoc.save());
}
