import { getDb } from "./connection";
import { assertOutsideRetention } from "./retention";
import type { Payment } from "./types";

// DAT-1.e / migration 0025 dropped the legacy REAL `amount` column. Payment
// reads and writes use `amount_cents` as the source of truth.
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
  // COMP-1.a (#90): GoBD retention guard. A payment is a booking-relevant
  // record and must be retained for the parent invoice's legal-profile
  // retention window. We look up the row + the parent invoice's country
  // code in a single query so the guard runs with zero extra round-trips
  // when the payment exists. If the row is missing we let the DELETE be
  // a no-op (consistent with deleteInvoice / deleteIncomingInvoice).
  const rows = await db.select<
    { created_at: string; legal_country_code: string | null }[]
  >(
    `SELECT p.created_at, i.legal_country_code
     FROM payments p
     LEFT JOIN invoices i ON i.id = p.invoice_id
     WHERE p.id = $1`,
    [id],
  );
  if (rows.length > 0) {
    assertOutsideRetention(
      "Zahlung",
      rows[0].legal_country_code,
      rows[0].created_at,
    );
  }
  await db.execute("DELETE FROM payments WHERE id = $1", [id]);
}
