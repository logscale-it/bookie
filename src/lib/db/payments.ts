import { getDb } from "./connection";
import type { Payment } from "./types";

// DAT-1.d (#54) / DAT-1.e (#55): all reads and writes use `amount_cents`.
// The legacy REAL `amount` column was dropped from the schema in migration 0023.
type CreatePayment = Omit<Payment, "id" | "created_at" | "updated_at">;

export interface PageResult<T> {
  rows: T[];
  totalCount: number;
}

export async function listByInvoice(
  invoiceId: number,
  opts?: { limit?: number; offset?: number },
): Promise<PageResult<Payment>> {
  // COUNT(*) OVER() computes the total in a single pass without a second round-trip.
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  const db = await getDb();
  const raw = await db.select<(Payment & { _total_count: number })[]>(
    `SELECT *, COUNT(*) OVER() AS _total_count
     FROM payments WHERE invoice_id = $1
     ORDER BY payment_date DESC LIMIT $2 OFFSET $3`,
    [invoiceId, limit, offset],
  );
  const totalCount = raw.length > 0 ? raw[0]._total_count : 0;
  const rows = raw.map(({ _total_count: _, ...rest }) => rest as Payment);
  return { rows, totalCount };
}

export async function createPayment(data: CreatePayment): Promise<number> {
  const db = await getDb();
  // `amount_cents` is the only money column after DAT-1.e (#55).
  const result = await db.execute(
    `INSERT INTO payments (invoice_id, payment_date, amount_cents, method, reference, note)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      data.invoice_id,
      data.payment_date,
      data.amount_cents,
      data.method,
      data.reference,
      data.note,
    ],
  );
  return result.lastInsertId!;
}

export async function deletePayment(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM payments WHERE id = $1", [id]);
}
