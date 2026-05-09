import { getDb, withTransaction, safeFields } from "./connection";
import type { Invoice } from "./types";

export type InvoiceWithCustomer = Invoice & { customer_name: string | null };

// DAT-1.d (#54): writes are repointed to `*_cents` (INTEGER minor units).
// The legacy REAL columns (`net_amount`, `tax_amount`, `gross_amount`) are
// kept in the read shape for compatibility but are no longer written here —
// they fall back to their `DEFAULT 0` from migration 0001 and are dropped
// in DAT-1.e (#55).
type CreateInvoice = Omit<
  Invoice,
  | "id"
  | "created_at"
  | "updated_at"
  | "net_amount"
  | "tax_amount"
  | "gross_amount"
>;
type UpdateInvoice = Partial<CreateInvoice>;

const ALLOWED_COLUMNS = [
  "company_id",
  "customer_id",
  "project_id",
  "invoice_number",
  "status",
  "issue_date",
  "due_date",
  "delivery_date",
  "service_period_start",
  "service_period_end",
  "currency",
  "net_cents",
  "tax_cents",
  "gross_cents",
  "due_surcharge",
  "issuer_name",
  "issuer_tax_number",
  "issuer_vat_id",
  "issuer_bank_account_holder",
  "issuer_bank_iban",
  "issuer_bank_bic",
  "issuer_bank_name",
  "recipient_name",
  "recipient_street",
  "recipient_postal_code",
  "recipient_city",
  "recipient_country_code",
  "notes",
  "s3_key",
  "language",
  "legal_country_code",
] as const;

export interface PageResult<T> {
  rows: T[];
  totalCount: number;
}

export async function listInvoices(
  companyId: number,
  opts?: { limit?: number; offset?: number },
): Promise<PageResult<Invoice>> {
  // COUNT(*) OVER() computes the total in a single pass without a second round-trip.
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  const db = await getDb();
  const raw = await db.select<(Invoice & { _total_count: number })[]>(
    `SELECT *, COUNT(*) OVER() AS _total_count
     FROM invoices WHERE company_id = $1
     ORDER BY issue_date DESC LIMIT $2 OFFSET $3`,
    [companyId, limit, offset],
  );
  const totalCount = raw.length > 0 ? raw[0]._total_count : 0;
  const rows = raw.map(({ _total_count: _, ...rest }) => rest as Invoice);
  return { rows, totalCount };
}

export async function getInvoiceById(id: number): Promise<Invoice | undefined> {
  const db = await getDb();
  const rows = await db.select<Invoice[]>(
    "SELECT * FROM invoices WHERE id = $1",
    [id],
  );
  return rows[0];
}

export async function createInvoice(data: CreateInvoice): Promise<number> {
  const db = await getDb();
  // Money columns: only the integer-cent columns are written. The legacy REAL
  // columns (`net_amount`, `tax_amount`, `gross_amount`) keep their migration
  // default of 0 — DAT-1.e (#55) drops them entirely.
  const result = await db.execute(
    `INSERT INTO invoices (company_id, customer_id, project_id, invoice_number, status, issue_date, due_date, service_period_start, service_period_end, currency, net_cents, tax_cents, gross_cents, issuer_name, issuer_tax_number, issuer_vat_id, issuer_bank_account_holder, issuer_bank_iban, issuer_bank_bic, issuer_bank_name, recipient_name, recipient_street, recipient_postal_code, recipient_city, recipient_country_code, notes)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
    [
      data.company_id,
      data.customer_id,
      data.project_id,
      data.invoice_number,
      data.status,
      data.issue_date,
      data.due_date,
      data.service_period_start,
      data.service_period_end,
      data.currency,
      data.net_cents,
      data.tax_cents,
      data.gross_cents,
      data.issuer_name,
      data.issuer_tax_number,
      data.issuer_vat_id,
      data.issuer_bank_account_holder,
      data.issuer_bank_iban,
      data.issuer_bank_bic,
      data.issuer_bank_name,
      data.recipient_name,
      data.recipient_street,
      data.recipient_postal_code,
      data.recipient_city,
      data.recipient_country_code,
      data.notes,
    ],
  );
  return result.lastInsertId!;
}

export async function updateInvoice(
  id: number,
  data: UpdateInvoice,
): Promise<void> {
  const fields = safeFields(data, ALLOWED_COLUMNS);
  if (fields.length === 0) return;

  const sets = fields.map(([key], i) => `${key} = $${i + 1}`);
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  const values = fields.map(([, v]) => v);
  values.push(id);

  const db = await getDb();
  await db.execute(
    `UPDATE invoices SET ${sets.join(", ")} WHERE id = $${values.length}`,
    values,
  );
}

export async function deleteInvoice(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM invoices WHERE id = $1", [id]);
}

export async function listAllInvoices(opts?: {
  limit?: number;
  offset?: number;
}): Promise<PageResult<InvoiceWithCustomer>> {
  // COUNT(*) OVER() computes the total in a single pass without a second round-trip.
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  const db = await getDb();
  const raw = await db.select<
    (InvoiceWithCustomer & { _total_count: number })[]
  >(`
		SELECT i.*, c.name AS customer_name, COUNT(*) OVER() AS _total_count
		FROM invoices i
		LEFT JOIN customers c ON i.customer_id = c.id
		ORDER BY i.issue_date DESC LIMIT ${limit} OFFSET ${offset}
	`);
  const totalCount = raw.length > 0 ? raw[0]._total_count : 0;
  const rows = raw.map(
    ({ _total_count: _, ...rest }) => rest as InvoiceWithCustomer,
  );
  return { rows, totalCount };
}

export async function updateInvoiceStatus(
  id: number,
  fromStatus: string | null,
  toStatus: string,
): Promise<void> {
  await withTransaction(async (db) => {
    await db.execute(
      `UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [toStatus, id],
    );
    await db.execute(
      `INSERT INTO invoice_status_history (invoice_id, from_status, to_status) VALUES ($1, $2, $3)`,
      [id, fromStatus, toStatus],
    );
  });
}
