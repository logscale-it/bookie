import { getDb } from "./connection";
import type { Payment } from "./types";

// DAT-1.d (#54): writes are repointed to `amount_cents`. The legacy REAL
// `amount` column has `CHECK (amount > 0)` (see migration 0001/07_payments.sql)
// so it cannot be left at 0; we derive its value from `amount_cents / 100` as
// a transitional placeholder until DAT-1.e (#55) drops the column.
type CreatePayment = Omit<
  Payment,
  "id" | "created_at" | "updated_at" | "amount"
>;

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
  // `amount_cents` carries the source-of-truth value. The legacy `amount`
  // column has a `CHECK (amount > 0)` constraint and cannot be left at 0; we
  // derive it from cents until DAT-1.e (#55) drops the column.
  const legacyAmount = data.amount_cents / 100;
  const result = await db.execute(
    `INSERT INTO payments (invoice_id, payment_date, amount, amount_cents, method, reference, note)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      data.invoice_id,
      data.payment_date,
      legacyAmount,
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
