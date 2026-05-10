import { getDb, safeFields } from "./connection";
import type { InvoiceItem } from "./types";

// DAT-1.d (#54) / DAT-1.e (#55): all reads and writes use `*_cents`. The
// legacy REAL columns `unit_price_net` / `line_total_net` were dropped from
// the schema in migration 0022.
type CreateInvoiceItem = Omit<InvoiceItem, "id" | "created_at" | "updated_at">;
type UpdateInvoiceItem = Partial<Omit<CreateInvoiceItem, "invoice_id">>;

const ALLOWED_COLUMNS = [
  "project_id",
  "time_entry_id",
  "position",
  "description",
  "quantity",
  "unit",
  "unit_price_net_cents",
  "tax_rate",
  "line_total_net_cents",
] as const;

export interface PageResult<T> {
  rows: T[];
  totalCount: number;
}

export async function listByInvoice(
  invoiceId: number,
  opts?: { limit?: number; offset?: number },
): Promise<PageResult<InvoiceItem>> {
  // COUNT(*) OVER() computes the total in a single pass without a second round-trip.
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  const db = await getDb();
  const raw = await db.select<(InvoiceItem & { _total_count: number })[]>(
    `SELECT *, COUNT(*) OVER() AS _total_count
     FROM invoice_items WHERE invoice_id = $1
     ORDER BY position LIMIT $2 OFFSET $3`,
    [invoiceId, limit, offset],
  );
  const totalCount = raw.length > 0 ? raw[0]._total_count : 0;
  const rows = raw.map(({ _total_count: _, ...rest }) => rest as InvoiceItem);
  return { rows, totalCount };
}

export async function createInvoiceItem(
  data: CreateInvoiceItem,
): Promise<number> {
  const db = await getDb();
  // Money columns: only `*_cents` exist after DAT-1.e (#55).
  const result = await db.execute(
    `INSERT INTO invoice_items (invoice_id, project_id, time_entry_id, position, description, quantity, unit, unit_price_net_cents, tax_rate, line_total_net_cents)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      data.invoice_id,
      data.project_id,
      data.time_entry_id,
      data.position,
      data.description,
      data.quantity,
      data.unit,
      data.unit_price_net_cents,
      data.tax_rate,
      data.line_total_net_cents,
    ],
  );
  return result.lastInsertId!;
}

export async function updateInvoiceItem(
  id: number,
  data: UpdateInvoiceItem,
): Promise<void> {
  const fields = safeFields(data, ALLOWED_COLUMNS);
  if (fields.length === 0) return;

  const sets = fields.map(([key], i) => `${key} = $${i + 1}`);
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  const values = fields.map(([, v]) => v);
  values.push(id);

  const db = await getDb();
  await db.execute(
    `UPDATE invoice_items SET ${sets.join(", ")} WHERE id = $${values.length}`,
    values,
  );
}

export async function deleteInvoiceItem(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM invoice_items WHERE id = $1", [id]);
}
