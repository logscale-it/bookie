import { getDb, safeFields } from "./connection";
import type { InvoiceItem } from "./types";

// `*_cents` fields are readable on `InvoiceItem` (DAT-1.b) but the write path
// is not yet repointed — that is DAT-1.d (#54). Exclude them from the
// Create/Update payload shape until then.
type CreateInvoiceItem = Omit<
  InvoiceItem,
  | "id"
  | "created_at"
  | "updated_at"
  | "unit_price_net_cents"
  | "line_total_net_cents"
>;
type UpdateInvoiceItem = Partial<Omit<CreateInvoiceItem, "invoice_id">>;

const ALLOWED_COLUMNS = [
  "project_id",
  "time_entry_id",
  "position",
  "description",
  "quantity",
  "unit",
  "unit_price_net",
  "tax_rate",
  "line_total_net",
] as const;

export async function listByInvoice(invoiceId: number): Promise<InvoiceItem[]> {
  const db = await getDb();
  return db.select(
    "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position",
    [invoiceId],
  );
}

export async function createInvoiceItem(
  data: CreateInvoiceItem,
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO invoice_items (invoice_id, project_id, time_entry_id, position, description, quantity, unit, unit_price_net, tax_rate, line_total_net)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      data.invoice_id,
      data.project_id,
      data.time_entry_id,
      data.position,
      data.description,
      data.quantity,
      data.unit,
      data.unit_price_net,
      data.tax_rate,
      data.line_total_net,
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
