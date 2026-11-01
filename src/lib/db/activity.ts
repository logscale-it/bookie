// Recent company events for the dashboard feed (src/common/ActivityFeed.svelte).
// Cloud: bookie-server GET /api/feed (invoice status moves + month approvals,
// filtered by the caller's grants). Local: derived from the invoices and
// their invoice_status_history (no actors: one user, one file).

import { api, cloud } from "$lib/cloud";
import { listCompanies } from "./companies";
import { getDb } from "./connection";

export type ActivityKind =
  | "created"
  | "issued"
  | "storno"
  | "paid"
  | "reopened"
  | "cancelled"
  | "approved"
  | "unapproved"
  | "rejected";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  /** ISO timestamp (UTC). */
  at: string;
  actor_id: number | null;
  actor_name: string | null;
  invoice_id?: number;
  invoice_number?: string | null;
  customer_name?: string | null;
  /** Month approvals: whose month (YYYY-MM). */
  subject_name?: string | null;
  month?: string | null;
};

/** Status move -> kind; same mapping as bookie-server src/api/activity.ts. */
export const invoiceKind = (
  from: string | null,
  to: string,
  storno: boolean,
): ActivityKind =>
  to === "draft"
    ? "created"
    : to === "paid"
      ? "paid"
      : to === "void" || to === "cancelled"
        ? "cancelled"
        : storno
          ? "storno"
          : from === "paid"
            ? "reopened"
            : "issued";

type LocalRow = {
  id: string;
  invoice_id: number;
  from_status: string | null;
  to_status: string;
  at: string;
  invoice_number: string;
  references_invoice_id: number | null;
  customer_name: string | null;
};

export async function listActivity(limit = 8): Promise<ActivityItem[]> {
  if (cloud()) return api<ActivityItem[]>(`/api/feed?limit=${limit}`);
  const companyId = (await listCompanies())[0]?.id;
  if (companyId == null) return [];
  const db = await getDb();
  // Local creation writes no history row: the invoice's created_at stands in (stornos have their own 'sent' row).
  const rows = await db.select<LocalRow[]>(
    `SELECT * FROM (
       SELECT 'h' || h.id AS id, h.invoice_id, h.from_status, h.to_status, h.changed_at AS at,
              i.invoice_number, i.references_invoice_id, c.name AS customer_name
       FROM invoice_status_history h JOIN invoices i ON i.id = h.invoice_id
       LEFT JOIN customers c ON c.id = i.customer_id WHERE i.company_id = $1
       UNION ALL
       SELECT 'c' || i.id, i.id, NULL, 'draft', i.created_at, i.invoice_number, i.references_invoice_id, c.name
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.company_id = $1 AND i.references_invoice_id IS NULL
     ) ORDER BY at DESC, id DESC LIMIT $2`,
    [companyId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: invoiceKind(r.from_status, r.to_status, r.references_invoice_id != null),
    // SQLite CURRENT_TIMESTAMP: "YYYY-MM-DD HH:MM:SS" in UTC.
    at: new Date(`${r.at.replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(r.at) ? "" : "Z"}`).toISOString(),
    actor_id: null,
    actor_name: null,
    invoice_id: r.invoice_id,
    invoice_number: r.invoice_number,
    customer_name: r.customer_name,
  }));
}
