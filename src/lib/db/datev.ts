import { api, cloud } from "$lib/cloud";
import { getDb } from "./connection";
import { yearBounds } from "./dashboard";
import { createLogger } from "$lib/logger";
import type { DatevBooking } from "$lib/csv/datev-csv";
import { isIbanlessTransfer, privateNames } from "$lib/csv/bank-csv";

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

interface BankRow {
  booking_date: string;
  partner_name: string;
  partner_iban: string | null;
  type: string;
  reference: string;
  amount_cents: number;
}

/** Imported bank line as signed booking, or null for a move between Spaces
 *  of the same account (transfer without partner IBAN, e.g. a tax reserve Space):
 *  the money never leaves the bank account, so there is nothing to book.
 *  `privateAccounts`: comma-separated partner names of the owner's private
 *  accounts (setting datev_private_accounts), booked as Privatentnahme/-einlage. */
export function bankBooking(
  b: BankRow,
  privateAccounts: string,
): DatevBooking | null {
  const isPrivate = privateNames(privateAccounts).includes(
    b.partner_name.trim().toLowerCase(),
  );
  if (!isPrivate && isIbanlessTransfer(b)) return null;
  return {
    grossCents: b.amount_cents,
    taxRate: 0,
    date: b.booking_date,
    documentNumber: "",
    text: [b.partner_name, b.reference].filter(Boolean).join(" "),
    kind: "bank",
    private: isPrivate,
  };
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
  if (cloud())
    return api(
      `/api/reports/datev-bookings?from=${year}-01-01&to=${year}-12-31`,
    );
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
       AND i.issue_date >= $2 AND i.issue_date < $3
       AND i.status IN ('sent', 'paid')
     GROUP BY i.id, ii.tax_rate
     ORDER BY i.issue_date, i.invoice_number, ii.tax_rate DESC`,
    [companyId, ...yearBounds(year)],
  );

  const expenseRows = await db.select<ExpenseRow[]>(
    `SELECT ii.invoice_number,
            ii.invoice_date,
            COALESCE(c.name, '') AS partner,
            ii.net_cents,
            ii.tax_cents
     FROM incoming_invoices ii
     LEFT JOIN customers c ON c.id = ii.supplier_id
     WHERE ii.company_id = $1 AND ii.invoice_date >= $2 AND ii.invoice_date < $3
     ORDER BY ii.invoice_date, ii.id`,
    [companyId, ...yearBounds(year)],
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

  const bankRows = await db.select<BankRow[]>(
    `SELECT booking_date, partner_name, partner_iban, type, reference, amount_cents
     FROM bank_transactions
     WHERE company_id = $1 AND booking_date >= $2 AND booking_date < $3
     ORDER BY booking_date, id`,
    [companyId, ...yearBounds(year)],
  );
  const [org] = await db.select<{ datev_private_accounts: string }[]>(
    "SELECT datev_private_accounts FROM settings_organization WHERE id = 1",
  );
  for (const b of bankRows) {
    const booking = bankBooking(b, org?.datev_private_accounts ?? "");
    if (booking) bookings.push(booking);
  }

  log.debug("DATEV booking rows", { year, count: bookings.length });
  return bookings;
}
