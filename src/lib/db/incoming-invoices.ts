import { getDb, safeFields } from "./connection";
import type { IncomingInvoice } from "./types";

type CreateIncomingInvoice = Omit<
  IncomingInvoice,
  "id" | "gross_amount" | "created_at" | "updated_at"
>;
type UpdateIncomingInvoice = Partial<Omit<CreateIncomingInvoice, "company_id">>;

const ALLOWED_COLUMNS = [
  "supplier_id",
  "invoice_number",
  "invoice_date",
  "net_amount",
  "tax_amount",
  "status",
  "file_data",
  "file_name",
  "file_type",
  "s3_key",
  "notes",
] as const;

export interface IncomingInvoiceWithSupplier extends IncomingInvoice {
  supplier_name: string | null;
}

export interface PageResult<T> {
  rows: T[];
  totalCount: number;
}

export async function listIncomingInvoices(
  companyId: number,
  opts?: { limit?: number; offset?: number },
): Promise<PageResult<IncomingInvoiceWithSupplier>> {
  // COUNT(*) OVER() computes the total in a single pass without a second round-trip.
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  const db = await getDb();
  const raw = await db.select<
    (IncomingInvoiceWithSupplier & { _total_count: number })[]
  >(
    `SELECT ii.id, ii.company_id, ii.supplier_id, ii.invoice_number, ii.invoice_date,
		        ii.net_amount, ii.tax_amount, ii.gross_amount, ii.status,
		        ii.file_name, ii.file_type, ii.s3_key, ii.notes, ii.created_at, ii.updated_at,
		        c.name as supplier_name, COUNT(*) OVER() AS _total_count
		 FROM incoming_invoices ii
		 LEFT JOIN customers c ON ii.supplier_id = c.id
		 WHERE ii.company_id = $1
		 ORDER BY ii.invoice_date DESC LIMIT $2 OFFSET $3`,
    [companyId, limit, offset],
  );
  const totalCount = raw.length > 0 ? raw[0]._total_count : 0;
  const rows = raw.map(
    ({ _total_count: _, ...rest }) => rest as IncomingInvoiceWithSupplier,
  );
  return { rows, totalCount };
}

export async function getIncomingInvoiceById(
  id: number,
): Promise<IncomingInvoice | undefined> {
  const db = await getDb();
  const rows = await db.select<IncomingInvoice[]>(
    "SELECT * FROM incoming_invoices WHERE id = $1",
    [id],
  );
  return rows[0];
}

export async function createIncomingInvoice(
  data: CreateIncomingInvoice,
): Promise<number> {
  const db = await getDb();
  const grossAmount = data.net_amount + data.tax_amount;
  const result = await db.execute(
    `INSERT INTO incoming_invoices (company_id, supplier_id, invoice_number, invoice_date,
		  net_amount, tax_amount, gross_amount, status, file_data, file_name, file_type, s3_key, notes)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      data.company_id,
      data.supplier_id,
      data.invoice_number,
      data.invoice_date,
      data.net_amount,
      data.tax_amount,
      grossAmount,
      data.status,
      data.file_data,
      data.file_name,
      data.file_type,
      data.s3_key,
      data.notes,
    ],
  );
  return result.lastInsertId!;
}

export async function updateIncomingInvoice(
  id: number,
  data: UpdateIncomingInvoice,
): Promise<void> {
  const fields = safeFields(data, ALLOWED_COLUMNS);
  if (fields.length === 0) return;

  const sets = fields.map(([key], i) => `${key} = $${i + 1}`);
  sets.push("updated_at = CURRENT_TIMESTAMP");

  const hasAmountChange = "net_amount" in data || "tax_amount" in data;
  if (hasAmountChange) {
    sets.push("gross_amount = net_amount + tax_amount");
  }

  const values = fields.map(([, v]) => v);
  values.push(id);

  const db = await getDb();
  await db.execute(
    `UPDATE incoming_invoices SET ${sets.join(", ")} WHERE id = $${values.length}`,
    values,
  );
}

export async function updateIncomingInvoiceStatus(
  id: number,
  status: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE incoming_invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
    [status, id],
  );
}

export async function deleteIncomingInvoice(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM incoming_invoices WHERE id = $1", [id]);
}

export async function getIncomingInvoiceFile(id: number): Promise<
  | {
      file_data: number[] | null;
      file_name: string | null;
      file_type: string | null;
      s3_key: string | null;
    }
  | undefined
> {
  const db = await getDb();
  const rows = await db.select<
    {
      file_data: number[] | null;
      file_name: string | null;
      file_type: string | null;
      s3_key: string | null;
    }[]
  >(
    "SELECT file_data, file_name, file_type, s3_key FROM incoming_invoices WHERE id = $1",
    [id],
  );
  return rows[0];
}
