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

export async function getRevenueByPeriod(
  companyId: number,
  year: number,
  groupBy: GroupBy,
): Promise<PeriodRow[]> {
  const db = await getDb();
  const expr = periodExpr(groupBy, "issue_date");
  const rows = await db.select<PeriodRow[]>(
    `SELECT ${expr} as period, COALESCE(SUM(net_amount), 0) as total_net, COALESCE(SUM(tax_amount), 0) as total_tax
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
    `SELECT ${expr} as period, COALESCE(SUM(net_amount), 0) as total_net, COALESCE(SUM(tax_amount), 0) as total_tax
     FROM incoming_invoices
     WHERE company_id = $1 AND strftime('%Y', invoice_date) = $2
     GROUP BY period ORDER BY period`,
    [companyId, String(year)],
  );
  log.debug("Costs by period", { year, groupBy, rows: rows.length });
  return rows;
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
