import { test, expect } from "bun:test";
import { createTestDb } from "./harness";

// #284: the year-range report filters must hit the composite indexes from
// migration 0031 instead of scanning or using the bare company_id index.
const cases: [string, string][] = [
  [
    "SELECT 1 FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id WHERE i.company_id = 1 AND i.issue_date >= '2025-01-01' AND i.issue_date < '2026-01-01' AND i.status IN ('sent', 'paid')",
    "idx_invoices_company_issue_date",
  ],
  [
    "SELECT 1 FROM incoming_invoices WHERE company_id = 1 AND invoice_date >= '2025-01-01' AND invoice_date < '2026-01-01'",
    "idx_incoming_invoices_company_invoice_date",
  ],
  [
    "SELECT 1 FROM invoices WHERE company_id = 1 AND status = 'paid' AND paid_date >= '2025-01-01' AND paid_date < '2026-01-01'",
    "idx_invoices_company_paid_date",
  ],
  [
    "SELECT 1 FROM incoming_invoices WHERE company_id = 1 AND status = 'bezahlt' AND paid_date >= '2025-01-01' AND paid_date < '2026-01-01'",
    "idx_incoming_invoices_company_paid_date",
  ],
];

test("report year filters use composite date indexes", () => {
  const db = createTestDb();
  for (const [sql, idx] of cases) {
    const plan = db.raw
      .query(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => (r as { detail: string }).detail)
      .join(" | ");
    expect(plan).toContain(`INDEX ${idx} (company_id=? AND`);
  }
});
