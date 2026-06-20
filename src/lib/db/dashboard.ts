import { getDb } from "./connection";
import { createLogger } from "$lib/logger";

const log = createLogger("dashboard");

export type GroupBy = "month" | "quarter" | "year";

export interface PeriodRow {
  period: string;
  total_net: number;
  total_tax: number;
}

export interface DashboardData {
  revenue: PeriodRow[];
  costs: PeriodRow[];
}

export function periodExpr(groupBy: GroupBy, dateCol: string): string {
  switch (groupBy) {
    case "month":
      return `strftime('%Y-%m', ${dateCol})`;
    case "quarter":
      return `strftime('%Y', ${dateCol}) || '-Q' || ((CAST(strftime('%m', ${dateCol}) AS INTEGER) - 1) / 3 + 1)`;
    case "year":
      return `strftime('%Y', ${dateCol})`;
  }
}

// DAT-1.d (#54): aggregations now read the integer-cent columns and divide
// by 100.0 at the SQL boundary so the consumer-facing API still returns
// `total_net` / `total_tax` in major units (euros). The legacy REAL columns
// are no longer populated by writes and would return 0 if queried.

export async function getRevenueByPeriod(
  companyId: number,
  year: number,
  groupBy: GroupBy,
): Promise<PeriodRow[]> {
  const db = await getDb();
  const expr = periodExpr(groupBy, "issue_date");
  const rows = await db.select<PeriodRow[]>(
    `SELECT ${expr} as period,
            COALESCE(SUM(net_cents), 0) / 100.0 as total_net,
            COALESCE(SUM(tax_cents), 0) / 100.0 as total_tax
     FROM invoices
     WHERE company_id = $1 AND strftime('%Y', issue_date) = $2 AND status IN ('sent', 'paid')
     GROUP BY period ORDER BY period`,
    [companyId, String(year)],
  );
  log.debug("Revenue by period", { year, groupBy, rows: rows.length });
  return rows;
}

export async function getCostsByPeriod(
  companyId: number,
  year: number,
  groupBy: GroupBy,
): Promise<PeriodRow[]> {
  const db = await getDb();
  const expr = periodExpr(groupBy, "invoice_date");
  const rows = await db.select<PeriodRow[]>(
    `SELECT ${expr} as period,
            COALESCE(SUM(net_cents), 0) / 100.0 as total_net,
            COALESCE(SUM(tax_cents), 0) / 100.0 as total_tax
     FROM incoming_invoices
     WHERE company_id = $1 AND strftime('%Y', invoice_date) = $2
     GROUP BY period ORDER BY period`,
    [companyId, String(year)],
  );
  log.debug("Costs by period", { year, groupBy, rows: rows.length });
  return rows;
}

export interface OverdueInvoice {
  id: number;
  invoice_number: string;
  customer_name: string | null;
  due_date: string;
  gross_cents: number;
}

/** Aggregate "needs attention" counters for the dashboard cockpit:
 *  overdue sent invoices, unsent drafts, and open (unpaid) incoming bills.
 *  Each bucket carries a count and a euro-cent total; overdue additionally
 *  returns the individual rows (oldest first) for a one-click jump list. */
export interface ActionItems {
  overdue: { count: number; totalCents: number; items: OverdueInvoice[] };
  drafts: { count: number; totalCents: number };
  openIncoming: { count: number; totalCents: number };
}

export async function getActionItems(companyId: number): Promise<ActionItems> {
  const db = await getDb();

  const overdueItems = await db.select<OverdueInvoice[]>(
    `SELECT i.id, i.invoice_number, c.name AS customer_name, i.due_date, i.gross_cents
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     WHERE i.company_id = $1
       AND i.status = 'sent'
       AND i.due_date IS NOT NULL
       AND i.due_date < date('now', 'localtime')
     ORDER BY i.due_date ASC`,
    [companyId],
  );
  const overdueTotal = overdueItems.reduce((s, r) => s + r.gross_cents, 0);

  const [draftRow] = await db.select<{ cnt: number; total: number }[]>(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(gross_cents), 0) AS total
     FROM invoices WHERE company_id = $1 AND status = 'draft'`,
    [companyId],
  );

  const [openRow] = await db.select<{ cnt: number; total: number }[]>(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(gross_cents), 0) AS total
     FROM incoming_invoices WHERE company_id = $1 AND status = 'offen'`,
    [companyId],
  );

  return {
    overdue: { count: overdueItems.length, totalCents: overdueTotal, items: overdueItems },
    drafts: { count: draftRow?.cnt ?? 0, totalCents: draftRow?.total ?? 0 },
    openIncoming: { count: openRow?.cnt ?? 0, totalCents: openRow?.total ?? 0 },
  };
}

export async function getDashboardData(
  companyId: number,
  year: number,
  groupBy: GroupBy,
): Promise<DashboardData> {
  const [revenue, costs] = await Promise.all([
    getRevenueByPeriod(companyId, year, groupBy),
    getCostsByPeriod(companyId, year, groupBy),
  ]);
  return { revenue, costs };
}
