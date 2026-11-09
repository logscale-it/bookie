import { api, cloud } from "$lib/cloud";
import type { BankTransaction } from "$lib/csv/bank-csv";
import { withTransaction } from "./connection";

export interface ImportResult {
  imported: number;
  duplicates: number;
}

/** Inserts parsed statement lines; lines already imported (same import_key) are skipped. */
export async function importBankTransactions(
  companyId: number,
  rows: BankTransaction[],
): Promise<ImportResult> {
  if (cloud())
    return api<ImportResult>("/api/bank-transactions/import", "POST", { rows });
  return withTransaction(async (db) => {
    let imported = 0;
    for (const r of rows) {
      const res = await db.execute(
        `INSERT INTO bank_transactions (company_id, booking_date, value_date, partner_name,
           partner_iban, type, reference, account_name, amount_cents, import_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (company_id, import_key) DO NOTHING`,
        [
          companyId,
          r.booking_date,
          r.value_date,
          r.partner_name,
          r.partner_iban,
          r.type,
          r.reference,
          r.account_name,
          r.amount_cents,
          r.import_key,
        ],
      );
      imported += res.rowsAffected;
    }
    return { imported, duplicates: rows.length - imported };
  });
}
