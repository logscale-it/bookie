// Finanzberater: gathers the numbers the calc engine needs from the existing
// db modules (local SQLite or bookie Cloud alike) plus the user's assumptions
// from localStorage (the bank balance is nowhere in the data).

import { cloud } from "$lib/cloud";
import { getDb } from "$lib/db/connection";
import { listAllInvoices } from "$lib/db/invoices";
import { listIncomingInvoices } from "$lib/db/incoming-invoices";
import { listRecurring } from "$lib/db/recurring";
import { getDashboardData } from "$lib/db/dashboard";
import { getEuerReport } from "$lib/db/tax-reports";
import {
  DEFAULT_ASSUMPTIONS,
  addMonths,
  monthOf,
  type Assumptions,
  type Facts,
  type MonthHistory,
  type RecurringFact,
} from "./calc";

const KEY = "bookie.advisor";

export function loadAssumptions(): Assumptions {
  try {
    return {
      ...DEFAULT_ASSUMPTIONS,
      ...JSON.parse(localStorage.getItem(KEY) ?? "{}"),
    };
  } catch {
    return { ...DEFAULT_ASSUMPTIONS };
  }
}
export function saveAssumptions(a: Assumptions): void {
  localStorage.setItem(KEY, JSON.stringify(a));
}

// ponytail: list caps at 1000 rows (server maximum); enough for a small business year.
const LIMIT = 1000;

/** Billable minutes not on any invoice, priced at the project rate. Local only; cloud has no such query. */
async function unbilledCents(companyId: number): Promise<number | null> {
  if (cloud()) return null;
  const db = await getDb();
  const [row] = await db.select<{ net: number }[]>(
    `SELECT COALESCE(SUM(te.duration_minutes / 60.0 * p.hourly_rate * 100), 0) AS net
     FROM time_entries te JOIN projects p ON p.id = te.project_id
     WHERE te.company_id = $1 AND te.billable = 1 AND p.hourly_rate IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.time_entry_id = te.id)`,
    [companyId],
  );
  // ponytail: gross at 19 %; per-item rates only exist once invoiced.
  return Math.round((row?.net ?? 0) * 1.19);
}

async function history(
  companyId: number,
  today: string,
): Promise<MonthHistory[]> {
  const y = Number(today.slice(0, 4));
  const [prev, cur] = await Promise.all([
    getDashboardData(companyId, y - 1, "month"),
    getDashboardData(companyId, y, "month"),
  ]);
  const rev = new Map(
    [...prev.revenue, ...cur.revenue].map((r) => [r.period, r]),
  );
  const cost = new Map([...prev.costs, ...cur.costs].map((r) => [r.period, r]));
  const start = addMonths(monthOf(today), -11);
  return Array.from({ length: 12 }, (_, i) => {
    const month = addMonths(start, i);
    const r = rev.get(month);
    const c = cost.get(month);
    const cents = (v?: number) => Math.round((v ?? 0) * 100);
    return {
      month,
      revenueGrossCents: cents(r?.total_net) + cents(r?.total_tax),
      revenueTaxCents: cents(r?.total_tax),
      costGrossCents: cents(c?.total_net) + cents(c?.total_tax),
      costTaxCents: cents(c?.total_tax),
    };
  });
}

function recurringFact(r: {
  kind: "invoice" | "incoming";
  label: string;
  frequency: RecurringFact["frequency"];
  interval_count: number;
  next_run_date: string;
  end_date: string | null;
  payload: string;
}): RecurringFact {
  let gross = 0;
  try {
    const p = JSON.parse(r.payload);
    const src = r.kind === "invoice" ? p.invoice : p;
    gross = Number(
      src?.gross_cents ??
        Number(src?.net_cents ?? 0) + Number(src?.tax_cents ?? 0),
    );
  } catch {
    /* unreadable snapshot: planned at 0 */
  }
  return {
    kind: r.kind,
    label: r.label,
    grossCents: gross,
    frequency: r.frequency,
    intervalCount: r.interval_count,
    nextRunDate: r.next_run_date,
    endDate: r.end_date,
  };
}

export async function gatherFacts(
  companyId: number,
  assumptions = loadAssumptions(),
  today = new Date().toISOString().slice(0, 10),
): Promise<Facts> {
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const [invoices, incoming, recurring, euer, hist, unbilled] =
    await Promise.all([
      listAllInvoices({ limit: LIMIT }),
      listIncomingInvoices(companyId, { limit: LIMIT }),
      listRecurring(),
      getEuerReport(companyId, `${today.slice(0, 4)}-01-01`, today),
      history(companyId, today),
      unbilledCents(companyId),
    ]);
  const mine = invoices.rows.filter((i) => i.company_id === companyId);
  return {
    today,
    receivables: mine
      .filter((i) => i.status === "sent" && i.gross_cents > 0)
      .map((i) => ({
        id: i.id,
        number: i.invoice_number,
        customer: i.customer_name,
        grossCents: i.gross_cents,
        issueDate: i.issue_date,
        dueDate: i.due_date,
      })),
    payables: incoming.rows
      .filter((b) => b.status === "offen")
      .map((b) => ({
        id: b.id,
        supplier: b.supplier_name,
        grossCents: b.gross_cents,
        invoiceDate: b.invoice_date,
      })),
    recurring: recurring
      .filter((r) => r.active && r.company_id === companyId)
      .map(recurringFact),
    unbilledCents: unbilled,
    history: hist,
    paid: mine
      .filter(
        (i) => i.status === "paid" && i.paid_date && i.paid_date >= yearAgo,
      )
      .map((i) => ({
        customer: i.customer_name,
        grossCents: i.gross_cents,
        issueDate: i.issue_date,
        dueDate: i.due_date,
        paidDate: i.paid_date!,
      })),
    profitYtdCents: Math.round(euer.profit * 100),
    assumptions,
  };
}
