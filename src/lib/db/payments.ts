import { getDb } from "./connection";
import type { Payment } from "./types";

// `amount_cents` is readable on `Payment` (DAT-1.b) but the write path is not
// yet repointed — that is DAT-1.d (#54). Exclude it from the Create payload
// shape until then.
type CreatePayment = Omit<
  Payment,
  "id" | "created_at" | "updated_at" | "amount_cents"
>;

export async function listByInvoice(invoiceId: number): Promise<Payment[]> {
  const db = await getDb();
  return db.select(
    "SELECT * FROM payments WHERE invoice_id = $1 ORDER BY payment_date DESC",
    [invoiceId],
  );
}

export async function createPayment(data: CreatePayment): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO payments (invoice_id, payment_date, amount, method, reference, note)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      data.invoice_id,
      data.payment_date,
      data.amount,
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
