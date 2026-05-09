/**
 * DSGVO (GDPR) data subject access export — Art. 15 disclosure.
 *
 * Produces a ZIP archive containing the full record set the application
 * stores about a single customer:
 *   - customer.json       — every column of the `customers` row
 *   - invoices.json       — every invoice row that references the customer
 *   - payments.json       — every payment attached to those invoices
 *   - audit_events.json   — every `invoice_audit` row that references the
 *                           customer, either directly via the invoice's
 *                           current customer_id or historically via the
 *                           audit row's `fields_diff.customer_id` field
 *   - DSGVO-Auskunft.pdf  — German-language human-readable summary
 *
 * The function is pure TypeScript and operates on the existing
 * `tauri-plugin-sql` connection (or a test-injected stub via
 * `__setDbForTesting`). The caller is responsible for picking a save path
 * and writing the bytes (e.g. via `dialog.save()` + `write_binary_file`).
 */

import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDb } from "./connection";
import type { Customer, Invoice, Payment } from "./types";

export interface AuditEvent {
  id: number;
  entity_type: string;
  entity_id: number;
  op: string;
  actor: string | null;
  ts_unix_us: number;
  fields_diff: string;
}

export interface CustomerExportBundle {
  customer: Customer;
  invoices: Invoice[];
  payments: Payment[];
  auditEvents: AuditEvent[];
}

/**
 * Collects every record the database stores about `customerId`.
 *
 * Audit semantics: we union (a) the current invoices of the customer and
 * (b) any historical invoice id whose `invoice_audit.fields_diff.customer_id`
 * pointed at this customer (catches deletes and reassignments), then return
 * every audit row keyed to those invoice ids across all three audited
 * entity types (`invoices`, `invoice_items`, `payments`).
 */
export async function collectCustomerData(
  customerId: number,
): Promise<CustomerExportBundle> {
  const db = await getDb();

  const customerRows = await db.select<Customer[]>(
    "SELECT * FROM customers WHERE id = $1",
    [customerId],
  );
  const customer = customerRows[0];
  if (!customer) {
    throw new Error(`Customer ${customerId} not found`);
  }

  const invoices = await db.select<Invoice[]>(
    "SELECT * FROM invoices WHERE customer_id = $1 ORDER BY issue_date, id",
    [customerId],
  );

  const currentInvoiceIds = invoices.map((inv) => inv.id);

  // Historical invoice ids — invoice_audit rows whose fields_diff says this
  // customer_id was either the previous (`before`) or new (`after`) value.
  // Catches the case where an invoice was deleted, or reassigned to a
  // different customer after this one's data was attached to it.
  const historicalRows = await db.select<{ entity_id: number }[]>(
    `SELECT DISTINCT entity_id
       FROM invoice_audit
      WHERE entity_type = 'invoices'
        AND (json_extract(fields_diff, '$.customer_id.before') = $1
          OR json_extract(fields_diff, '$.customer_id.after')  = $1)`,
    [customerId],
  );

  const allInvoiceIds = new Set<number>([
    ...currentInvoiceIds,
    ...historicalRows.map((r) => r.entity_id),
  ]);

  let payments: Payment[] = [];
  let auditEvents: AuditEvent[] = [];

  if (allInvoiceIds.size > 0) {
    const ids = [...allInvoiceIds];
    // Build a parameterised IN-list (SQLite has no native array binding via
    // tauri-plugin-sql).
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");

    payments = await db.select<Payment[]>(
      `SELECT * FROM payments
         WHERE invoice_id IN (${placeholders})
         ORDER BY payment_date, id`,
      ids,
    );

    auditEvents = await db.select<AuditEvent[]>(
      `SELECT * FROM invoice_audit
         WHERE entity_type IN ('invoices', 'invoice_items', 'payments')
           AND entity_id IN (${placeholders})
         ORDER BY ts_unix_us, id`,
      ids,
    );
  }

  return { customer, invoices, payments, auditEvents };
}

/**
 * German-language one-page PDF summary that accompanies the JSON files.
 * Intentionally minimal — the JSON exports are the substantive disclosure;
 * the PDF is the human-readable index a reviewer / data subject can skim.
 */
async function buildSummaryPdf(
  bundle: CustomerExportBundle,
  exportedAt: Date,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // A4 = 595 x 842 pt
  const page = pdf.addPage([595, 842]);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const accent = rgb(37 / 255, 99 / 255, 235 / 255);

  // Accent strip
  page.drawRectangle({
    x: 0,
    y: 838,
    width: 595,
    height: 4,
    color: accent,
  });

  const left = 50;
  let y = 780;

  page.drawText("DSGVO-Auskunft", {
    x: left,
    y,
    size: 22,
    font: fontBold,
    color: black,
  });
  y -= 28;

  page.drawText(bundle.customer.name, {
    x: left,
    y,
    size: 14,
    font: fontBold,
    color: black,
  });
  y -= 22;

  const formattedDate = exportedAt.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  page.drawText(`Stand: ${formattedDate} Uhr`, {
    x: left,
    y,
    size: 10,
    font,
    color: gray,
  });
  y -= 30;

  // Section: customer identity (a few key fields, the full set is in
  // customer.json — the PDF is just a quick index)
  const identityLines: Array<[string, string]> = [
    ["Kundennummer", bundle.customer.customer_number ?? "—"],
    ["E-Mail", bundle.customer.email ?? "—"],
    ["Telefon", bundle.customer.phone ?? "—"],
    [
      "Anschrift",
      [
        bundle.customer.street,
        [bundle.customer.postal_code, bundle.customer.city]
          .filter(Boolean)
          .join(" "),
        bundle.customer.country_code,
      ]
        .filter(Boolean)
        .join(", ") || "—",
    ],
    ["USt-IdNr.", bundle.customer.vat_id ?? "—"],
  ];

  for (const [label, value] of identityLines) {
    page.drawText(`${label}:`, {
      x: left,
      y,
      size: 10,
      font: fontBold,
      color: black,
    });
    page.drawText(value, {
      x: left + 110,
      y,
      size: 10,
      font,
      color: black,
    });
    y -= 16;
  }

  y -= 12;
  page.drawText("Umfang der Auskunft", {
    x: left,
    y,
    size: 12,
    font: fontBold,
    color: black,
  });
  y -= 18;

  const counts: Array<[string, number]> = [
    ["Rechnungen", bundle.invoices.length],
    ["Zahlungen", bundle.payments.length],
    ["Auditereignisse", bundle.auditEvents.length],
  ];

  for (const [label, n] of counts) {
    page.drawText(`${label}: ${n}`, {
      x: left,
      y,
      size: 10,
      font,
      color: black,
    });
    y -= 14;
  }

  y -= 16;
  page.drawText("Hinweise", {
    x: left,
    y,
    size: 12,
    font: fontBold,
    color: black,
  });
  y -= 18;

  const noteParagraphs = [
    "Diese Auskunft wird gemäß Art. 15 DSGVO erteilt. Die beiliegenden " +
      "JSON-Dateien (customer.json, invoices.json, payments.json, " +
      "audit_events.json) enthalten den vollständigen Datenbestand zu " +
      "Ihrer Person bzw. Ihrem Unternehmen.",
    "Rechnungen und zugehörige Buchungsbelege werden gemäß § 147 AO für " +
      "die Dauer von zehn Jahren aufbewahrt. Eine Löschung vor Ablauf " +
      "dieser gesetzlichen Aufbewahrungsfrist ist nicht möglich.",
    "Die Datei audit_events.json dokumentiert sämtliche Änderungen an " +
      "den Rechnungen, Rechnungspositionen und Zahlungen, die Ihren " +
      "Datensatz betreffen. Sie dient der GoBD-Konformität (Grundsätze " +
      "ordnungsmäßiger Buchführung).",
  ];

  const wrapWidth = 495; // pt, so 50pt margins on each side of A4
  for (const paragraph of noteParagraphs) {
    const lines = wrapText(paragraph, font, 9.5, wrapWidth);
    for (const line of lines) {
      page.drawText(line, { x: left, y, size: 9.5, font, color: black });
      y -= 13;
    }
    y -= 6;
  }

  return pdf.save();
}

/** Greedy word-wrap. Returns at most one line if there are no spaces. */
function wrapText(
  text: string,
  font: import("pdf-lib").PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, size);
    if (width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) lines.push("");
  return lines;
}

/**
 * Builds the DSGVO export ZIP for a single customer.
 *
 * The result is a `Uint8Array` so it can be passed directly to the
 * existing `write_binary_file` Tauri command (see `csv-writer.ts` for
 * the same pattern).
 */
export async function exportCustomerData(
  customerId: number,
): Promise<Uint8Array> {
  const bundle = await collectCustomerData(customerId);
  const exportedAt = new Date();

  const zip = new JSZip();
  zip.file("customer.json", JSON.stringify(bundle.customer, null, 2));
  zip.file("invoices.json", JSON.stringify(bundle.invoices, null, 2));
  zip.file("payments.json", JSON.stringify(bundle.payments, null, 2));
  zip.file("audit_events.json", JSON.stringify(bundle.auditEvents, null, 2));

  const pdfBytes = await buildSummaryPdf(bundle, exportedAt);
  zip.file("DSGVO-Auskunft.pdf", pdfBytes);

  // metadata.json gives auditors a single place to confirm what the bundle
  // is, when it was produced, and which counts to expect.
  zip.file(
    "metadata.json",
    JSON.stringify(
      {
        bundle_kind: "dsgvo_subject_access_export",
        customer_id: bundle.customer.id,
        customer_name: bundle.customer.name,
        exported_at: exportedAt.toISOString(),
        counts: {
          invoices: bundle.invoices.length,
          payments: bundle.payments.length,
          audit_events: bundle.auditEvents.length,
        },
      },
      null,
      2,
    ),
  );

  const blob = await zip.generateAsync({ type: "uint8array" });
  return blob;
}

/** Default file name suggestion for a save dialog. */
export function suggestExportFileName(
  customer: Pick<Customer, "id" | "name">,
  now: Date = new Date(),
): string {
  const ymd = now.toISOString().slice(0, 10);
  const safeName =
    customer.name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip diacritics
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || `customer-${customer.id}`;
  return `dsgvo-auskunft-${safeName}-${ymd}.zip`;
}
