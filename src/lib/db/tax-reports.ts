import { getDb } from "./connection";
import { periodExpr, type GroupBy } from "./dashboard";
import { createLogger } from "$lib/logger";

const log = createLogger("tax-reports");

export interface UstvaRow {
  period: string;
  revenue19Net: number;
  vat19: number;
  revenue7Net: number;
  vat7: number;
  revenue0Net: number;
  inputTaxNet: number;
  inputTaxVat: number;
  vatPayable: number;
}

export interface EuerRow {
  period: string;
  incomeNet: number;
  incomeTax: number;
  incomeGross: number;
  expenseNet: number;
  expenseTax: number;
  expenseGross: number;
  profit: number;
}

interface RevenueByRateRow {
  period: string;
  tax_rate: number;
  total_net: number;
  total_vat: number;
}

interface PeriodTotalRow {
  period: string;
  total_net: number;
  total_tax: number;
}

export async function getUstvaData(
  companyId: number,
  year: number,
  groupBy: GroupBy,
): Promise<UstvaRow[]> {
  const db = await getDb();
  const expr = periodExpr(groupBy, "i.issue_date");

  // Revenue broken down by tax rate
  const revenueRows = await db.select<RevenueByRateRow[]>(
    `SELECT ${expr} as period,
            ii.tax_rate,
            COALESCE(SUM(ii.line_total_net), 0) as total_net,
            COALESCE(SUM(ii.line_total_net * ii.tax_rate / 100.0), 0) as total_vat
     FROM invoices i
     JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE i.company_id = $1
       AND strftime('%Y', i.issue_date) = $2
       AND i.status IN ('sent', 'paid')
     GROUP BY period, ii.tax_rate
     ORDER BY period`,
    [companyId, String(year)],
  );

  // Input tax from incoming invoices
  const inputExpr = periodExpr(groupBy, "invoice_date");
  const inputRows = await db.select<PeriodTotalRow[]>(
    `SELECT ${inputExpr} as period,
            COALESCE(SUM(net_amount), 0) as total_net,
            COALESCE(SUM(tax_amount), 0) as total_tax
     FROM incoming_invoices
     WHERE company_id = $1 AND strftime('%Y', invoice_date) = $2
     GROUP BY period ORDER BY period`,
    [companyId, String(year)],
  );

  // Build period map
  const periods = new Map<
    string,
    {
      r19n: number;
      v19: number;
      r7n: number;
      v7: number;
      r0n: number;
      inN: number;
      inV: number;
    }
  >();

  const ensure = (p: string) => {
    if (!periods.has(p))
      periods.set(p, {
        r19n: 0,
        v19: 0,
        r7n: 0,
        v7: 0,
        r0n: 0,
        inN: 0,
        inV: 0,
      });
    return periods.get(p)!;
  };

  for (const row of revenueRows) {
    const d = ensure(row.period);
    if (row.tax_rate === 19) {
      d.r19n += row.total_net;
      d.v19 += row.total_vat;
    } else if (row.tax_rate === 7) {
      d.r7n += row.total_net;
      d.v7 += row.total_vat;
    } else {
      d.r0n += row.total_net;
    }
  }

  for (const row of inputRows) {
    const d = ensure(row.period);
    d.inN += row.total_net;
    d.inV += row.total_tax;
  }

  const result: UstvaRow[] = [];
  for (const [period, d] of [...periods.entries()].sort()) {
    const vatOut = d.v19 + d.v7;
    result.push({
      period,
      revenue19Net: d.r19n,
      vat19: d.v19,
      revenue7Net: d.r7n,
      vat7: d.v7,
      revenue0Net: d.r0n,
      inputTaxNet: d.inN,
      inputTaxVat: d.inV,
      vatPayable: vatOut - d.inV,
    });
  }

  log.debug("UStVA data", { year, groupBy, rows: result.length });
  return result;
}

export async function getEuerData(
  companyId: number,
  year: number,
  groupBy: GroupBy,
): Promise<EuerRow[]> {
  const db = await getDb();
  const incomeExpr = periodExpr(groupBy, "issue_date");
  const expenseExpr = periodExpr(groupBy, "invoice_date");

  const incomeRows = await db.select<PeriodTotalRow[]>(
    `SELECT ${incomeExpr} as period,
            COALESCE(SUM(net_amount), 0) as total_net,
            COALESCE(SUM(tax_amount), 0) as total_tax
     FROM invoices
     WHERE company_id = $1
       AND strftime('%Y', issue_date) = $2
       AND status IN ('sent', 'paid')
     GROUP BY period ORDER BY period`,
    [companyId, String(year)],
  );

  const expenseRows = await db.select<PeriodTotalRow[]>(
    `SELECT ${expenseExpr} as period,
            COALESCE(SUM(net_amount), 0) as total_net,
            COALESCE(SUM(tax_amount), 0) as total_tax
     FROM incoming_invoices
     WHERE company_id = $1 AND strftime('%Y', invoice_date) = $2
     GROUP BY period ORDER BY period`,
    [companyId, String(year)],
  );

  const periods = new Map<
    string,
    { iN: number; iT: number; eN: number; eT: number }
  >();
  const ensure = (p: string) => {
    if (!periods.has(p)) periods.set(p, { iN: 0, iT: 0, eN: 0, eT: 0 });
    return periods.get(p)!;
  };

  for (const row of incomeRows) {
    const d = ensure(row.period);
    d.iN += row.total_net;
    d.iT += row.total_tax;
  }

  for (const row of expenseRows) {
    const d = ensure(row.period);
    d.eN += row.total_net;
    d.eT += row.total_tax;
  }

  const result: EuerRow[] = [];
  for (const [period, d] of [...periods.entries()].sort()) {
    result.push({
      period,
      incomeNet: d.iN,
      incomeTax: d.iT,
      incomeGross: d.iN + d.iT,
      expenseNet: d.eN,
      expenseTax: d.eT,
      expenseGross: d.eN + d.eT,
      profit: d.iN - d.eN,
    });
  }

  log.debug("EÜR data", { year, groupBy, rows: result.length });
  return result;
}
