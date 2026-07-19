import { getDb } from "./connection";
import { createLogger } from "$lib/logger";
import type { DatevBooking } from "$lib/csv/datev-csv";

const log = createLogger("datev");

interface RevenueRow {
  invoice_number: string;
  issue_date: string;
  partner: string;
  tax_rate: number;
  net_cents: number;
}

interface ExpenseRow {
  invoice_number: string | null;
  invoice_date: string;
  partner: string;
  net_cents: number;
  tax_cents: number;
}

/** Snap a derived percentage to the German standard rates used for
 *  account/BU mapping; anything else falls through as 0 (booked gross). */
function normalizeRate(rate: number): number {
  if (Math.abs(rate - 19) <= 0.5) return 19;
  if (Math.abs(rate - 7) <= 0.5) return 7;
  return 0;
}

/**
 * Booking source rows for the DATEV Buchungsstapel export: one row per
 * outgoing invoice and VAT rate (sent/paid only, same filter as the UStVA
 * report) plus one row per incoming invoice, all within the given year.
 */
export async function getDatevBookingRows(
  companyId: number,
  year: number,
): Promise<DatevBooking[]> {
  const db = await getDb();

  const revenueRows = await db.select<RevenueRow[]>(
    `SELECT i.invoice_number,
            i.issue_date,
            COALESCE(NULLIF(i.recipient_name, ''), c.name, '') AS partner,
            ii.tax_rate,
            COALESCE(SUM(ii.line_total_net_cents), 0) AS net_cents
     FROM invoices i
     JOIN invoice_items ii ON ii.invoice_id = i.id
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.company_id = $1
       AND strftime('%Y', i.issue_date) = $2
       AND i.status IN ('sent', 'paid')
     GROUP BY i.id, ii.tax_rate
     ORDER BY i.issue_date, i.invoice_number, ii.tax_rate DESC`,
    [companyId, String(year)],
  );

  const expenseRows = await db.select<ExpenseRow[]>(
    `SELECT ii.invoice_number,
            ii.invoice_date,
            COALESCE(c.name, '') AS partner,
            ii.net_cents,
            ii.tax_cents
     FROM incoming_invoices ii
     LEFT JOIN customers c ON c.id = ii.supplier_id
     WHERE ii.company_id = $1 AND strftime('%Y', ii.invoice_date) = $2
     ORDER BY ii.invoice_date, ii.id`,
    [companyId, String(year)],
  );

  const bookings: DatevBooking[] = [];

  for (const r of revenueRows) {
    const rate = normalizeRate(r.tax_rate);
    bookings.push({
      grossCents: r.net_cents + Math.round((r.net_cents * r.tax_rate) / 100),
      taxRate: rate,
      date: r.issue_date,
      documentNumber: r.invoice_number,
      text: r.partner,
      kind: "revenue",
    });
  }

  for (const e of expenseRows) {
    const derived = e.net_cents > 0 ? (e.tax_cents / e.net_cents) * 100 : 0;
    bookings.push({
      grossCents: e.net_cents + e.tax_cents,
      taxRate: normalizeRate(derived),
      date: e.invoice_date,
      documentNumber: e.invoice_number ?? "",
      text: e.partner,
      kind: "expense",
    });
  }

  log.debug("DATEV booking rows", { year, count: bookings.length });
  return bookings;
}
