import { getDb, safeFields } from "./connection";
import type { IncomingInvoice } from "./types";

// DAT-1.e / migration 0025 dropped the legacy REAL money columns. All
// incoming-invoice reads and writes use the integer-cent columns as the
// source of truth.
//
// DAT-5.b (#66): `local_path` is populated by the DAT-5.a backfill OR by the
// no-S3 upload path in the UI; either way it is supplied here when the row
// has a file on disk. The `file_data` BLOB column is no longer touched by
// any read or write in this module — the only remaining reference to it
// lives in `backfill-file-data.ts`, which exists solely to evacuate it.
type CreateIncomingInvoice = Omit<
  IncomingInvoice,
  "id" | "created_at" | "updated_at" | "gross_cents"
>;
type UpdateIncomingInvoice = Partial<Omit<CreateIncomingInvoice, "company_id">>;

// DAT-5.b: `file_data` removed. New rows store their PDF either in S3
// (`s3_key`) or on disk (`local_path`). The column is still present in the
// schema for the in-flight backfill but is never written from this module.
const ALLOWED_COLUMNS = [
  "supplier_id",
  "invoice_number",
  "invoice_date",
  "net_cents",
  "tax_cents",
  "gross_cents",
  "status",
  "file_name",
  "file_type",
  "s3_key",
  "local_path",
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
		        ii.net_cents, ii.tax_cents, ii.gross_cents, ii.status,
		        ii.file_name, ii.file_type, ii.s3_key, ii.local_path,
		        ii.notes, ii.created_at, ii.updated_at,
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
  // `gross_cents` is derived once at write time so the reader sees a
  // consistent total.
  //
  // DAT-5.b: the legacy `file_data` BLOB column is intentionally not in the
  // INSERT list. It defaults to NULL at the SQL layer; new rows route their
  // PDF to `s3_key` (S3 path) or `local_path` (disk path) instead.
  const grossCents = data.net_cents + data.tax_cents;
  const result = await db.execute(
    `INSERT INTO incoming_invoices (company_id, supplier_id, invoice_number, invoice_date,
		  net_cents, tax_cents, gross_cents,
		  status, file_name, file_type, s3_key, local_path, notes)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      data.company_id,
      data.supplier_id,
      data.invoice_number,
      data.invoice_date,
      data.net_cents,
      data.tax_cents,
      grossCents,
      data.status,
      data.file_name,
      data.file_type,
      data.s3_key,
      data.local_path,
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

  const db = await getDb();

  // Keep `gross_cents` consistent when either of its inputs is updated.
  // SQLite evaluates UPDATE SET expressions against the OLD row, so we
  // can't compute gross_cents from net_cents + tax_cents in one statement;
  // we read the current values, merge the partial patch, and persist a
  // resolved gross_cents alongside.
  const hasAmountChange = "net_cents" in data || "tax_cents" in data;
  if (hasAmountChange) {
    const current = await db.select<{ net_cents: number; tax_cents: number }[]>(
      "SELECT net_cents, tax_cents FROM incoming_invoices WHERE id = $1",
      [id],
    );
    if (current.length > 0) {
      const merged = {
        net_cents: (data.net_cents ?? current[0].net_cents) as number,
        tax_cents: (data.tax_cents ?? current[0].tax_cents) as number,
      };
      const idx = fields.findIndex(([k]) => k === "net_cents");
      if (idx >= 0) fields[idx] = ["net_cents", merged.net_cents];
      else fields.push(["net_cents", merged.net_cents]);
      const tIdx = fields.findIndex(([k]) => k === "tax_cents");
      if (tIdx >= 0) fields[tIdx] = ["tax_cents", merged.tax_cents];
      else fields.push(["tax_cents", merged.tax_cents]);
      fields.push(["gross_cents", merged.net_cents + merged.tax_cents]);
    }
  }

  const sets = fields.map(([key], i) => `${key} = $${i + 1}`);
  sets.push("updated_at = CURRENT_TIMESTAMP");
  const values = fields.map(([, v]) => v);
  values.push(id);

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

// DAT-5.b: read path returns ONLY `s3_key` / `local_path` — the legacy
// `file_data` BLOB is no longer surfaced. Callers that previously fell
// through to it must now treat a row with neither column populated as
// "no file attached". Rows that still hold a BLOB on disk should be
// evacuated by `backfillIncomingInvoiceFileData` (DAT-5.a) before being
// read through this function.
export async function getIncomingInvoiceFile(id: number): Promise<
  | {
      file_name: string | null;
      file_type: string | null;
      s3_key: string | null;
      local_path: string | null;
    }
  | undefined
> {
  const db = await getDb();
  const rows = await db.select<
    {
      file_name: string | null;
      file_type: string | null;
      s3_key: string | null;
      local_path: string | null;
    }[]
  >(
    "SELECT file_name, file_type, s3_key, local_path FROM incoming_invoices WHERE id = $1",
    [id],
  );
  return rows[0];
}
