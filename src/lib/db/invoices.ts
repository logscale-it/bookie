import { getDb, withTransaction, safeFields } from "./connection";
import { assertOutsideRetention } from "./retention";
import type { Invoice, InvoiceItem } from "./types";

export type InvoiceWithCustomer = Invoice & { customer_name: string | null };

// DAT-1.e / migration 0025 dropped the legacy REAL money columns. All
// invoice reads and writes use the integer-cent columns as the source of
// truth.
//
// `references_invoice_id` and `cancellation_reason` are written exclusively
// by `cancelInvoice` (DAT-2.b). External callers must not be able to set
// them via createInvoice / updateInvoice, so they are excluded here too.

/**
 * Thrown by updateInvoice / deleteInvoice when the target invoice has left
 * 'draft' (GoBD: issued invoices are immutable), and by cancelInvoice when
 * the target invoice is still a draft (drafts must be deleted, not stornoed).
 *
 * The `name` discriminator lets the UI branch on the failure mode without
 * string-matching the SQL trigger's 'invoice_immutable' message — the SQL
 * trigger remains the ultimate guard (DAT-2.a, migration 0020), but this
 * pre-check produces a friendlier, typed error before the round-trip.
 *
 * TODO: replace with the typed BookieError class once OBS-2.c (#73) lands;
 * until then we use a plain Error with `.name = 'InvoiceImmutable'` so we
 * don't introduce an ad-hoc TS error class that will be renamed shortly.
 */
function invoiceImmutableError(message: string): Error {
  const err = new Error(message);
  err.name = "InvoiceImmutable";
  return err;
}

type CreateInvoice = Omit<
  Invoice,
  | "id"
  | "created_at"
  | "updated_at"
  | "references_invoice_id"
  | "cancellation_reason"
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

  // GoBD pre-check (DAT-2.b): refuse mutations on issued invoices before the
  // SQL trigger (DAT-2.a, migration 0020) does, so the UI gets a typed
  // InvoiceImmutable error rather than a raw 'invoice_immutable' constraint
  // failure. Missing-row case falls through to the UPDATE (which is a no-op).
  const existing = await getInvoiceById(id);
  if (existing && existing.status !== "draft") {
    throw invoiceImmutableError(
      `Rechnung im Status '${existing.status}' kann nicht geändert werden`,
    );
  }

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
  // GoBD pre-check (DAT-2.b): refuse delete on issued invoices before the
  // SQL trigger (DAT-2.a, migration 0020) does. Missing-row case falls
  // through to the DELETE (which is a no-op).
  const existing = await getInvoiceById(id);
  if (existing && existing.status !== "draft") {
    throw invoiceImmutableError(
      `Rechnung im Status '${existing.status}' kann nicht gelöscht werden`,
    );
  }

  // COMP-1.a (#90): GoBD §147 AO retention guard. Even drafts that are old
  // enough to fall outside the window are still books-relevant, so we apply
  // the guard for any existing row regardless of status. The
  // InvoiceImmutable check above already covers issued/storno rows; in
  // practice this branch fires for an old `draft` that was never issued.
  if (existing) {
    assertOutsideRetention(
      "Rechnung",
      existing.legal_country_code,
      existing.created_at,
    );
  }

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

/**
 * DAT-2.b: cancel an issued invoice by creating a storno (reversing) entry.
 *
 * A storno is a German bookkeeping convention: rather than mutate the
 * original (which GoBD forbids once issued), we insert a sibling invoice
 * that mirrors the original with negated amounts, points back at the
 * original via `references_invoice_id`, and is itself issued (and therefore
 * immutable). The original invoice's row is left bit-for-bit unchanged.
 *
 * - The storno's `invoice_number` is `<original.invoice_number>-storno-N`,
 *   where N starts at 1 and increments only if a storno for this original
 *   already exists (defensive: the typical flow stops after one storno).
 * - `net_cents`, `tax_cents`, `gross_cents`, and `due_surcharge` are all
 *   negated.
 * - `status` is `'issued'`. A row in `invoice_status_history` records the
 *   transition from NULL -> 'issued' so the storno appears in audit views.
 * - Line items from the original are mirrored with `quantity` and
 *   `line_total_net_cents` negated; `unit_price_net_cents` is kept positive
 *   so the invariant line_total = quantity * unit_price holds.
 * - `cancellation_reason` stores the user-supplied `reason`.
 * - Drafts cannot be cancelled — they should be deleted via deleteInvoice.
 *   This guard throws InvoiceImmutable too, since the user is trying to
 *   storno something the law does not yet consider a real document.
 *
 * Everything runs in a single SQL transaction; on any failure the storno
 * and its line items are rolled back and the original is unaffected.
 *
 * @returns the new storno invoice's id.
 */
export async function cancelInvoice(
  id: number,
  reason: string,
): Promise<number> {
  const original = await getInvoiceById(id);
  if (!original) {
    throw new Error(`Invoice with id ${id} not found`);
  }
  if (original.status === "draft") {
    throw invoiceImmutableError(
      "Entwurfsrechnungen können nicht storniert werden — bitte löschen statt stornieren",
    );
  }

  return await withTransaction(async (db) => {
    // Determine the next storno suffix N. Look up existing stornos via the
    // FK column rather than LIKE matching on invoice_number — robust to
    // numbers that themselves contain "-storno-" substrings.
    const existingStornos = await db.select<{ invoice_number: string }[]>(
      `SELECT invoice_number FROM invoices
       WHERE references_invoice_id = $1 AND company_id = $2`,
      [id, original.company_id],
    );
    const stornoSuffix = existingStornos.length + 1;
    const stornoNumber = `${original.invoice_number}-storno-${stornoSuffix}`;
    const today = new Date().toISOString().slice(0, 10);

    // Insert the storno header. Negate every monetary column so the storno
    // exactly offsets the original on the books. issue_date = today (the
    // storno's effective date), service period and due date are copied
    // verbatim because they describe the *original* engagement being
    // reversed; recipient and issuer details are likewise copied so the
    // storno is a self-contained invoice the recipient can file.
    const result = await db.execute(
      `INSERT INTO invoices (
         company_id, customer_id, project_id, invoice_number, status,
         issue_date, due_date, service_period_start, service_period_end,
         currency,
         net_cents, tax_cents, gross_cents,
         issuer_name, issuer_tax_number, issuer_vat_id,
         issuer_bank_account_holder, issuer_bank_iban, issuer_bank_bic,
         issuer_bank_name,
         recipient_name, recipient_street, recipient_postal_code,
         recipient_city, recipient_country_code,
         delivery_date, due_surcharge, language, legal_country_code,
         notes, references_invoice_id, cancellation_reason
       ) VALUES (
         $1, $2, $3, $4, 'issued',
         $5, $6, $7, $8,
         $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18,
         $19,
         $20, $21, $22,
         $23, $24,
         $25, $26, $27, $28,
         $29, $30, $31
       )`,
      [
        original.company_id,
        original.customer_id,
        original.project_id,
        stornoNumber,
        today,
        original.due_date,
        original.service_period_start,
        original.service_period_end,
        original.currency,
        -original.net_cents,
        -original.tax_cents,
        -original.gross_cents,
        original.issuer_name,
        original.issuer_tax_number,
        original.issuer_vat_id,
        original.issuer_bank_account_holder,
        original.issuer_bank_iban,
        original.issuer_bank_bic,
        original.issuer_bank_name,
        original.recipient_name,
        original.recipient_street,
        original.recipient_postal_code,
        original.recipient_city,
        original.recipient_country_code,
        original.delivery_date,
        -original.due_surcharge,
        original.language,
        original.legal_country_code,
        original.notes,
        id,
        reason,
      ],
    );
    const stornoId = result.lastInsertId!;

    // Mirror line items with negated quantity & line totals. We keep
    // unit_price_net_cents positive so the invariant
    //   line_total_net_cents = quantity * unit_price_net_cents
    // continues to hold for the storno row, which makes downstream tax
    // calculations and PDF rendering symmetric with the original.
    const items = await db.select<InvoiceItem[]>(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position`,
      [id],
    );
    for (const item of items) {
      await db.execute(
        `INSERT INTO invoice_items (
           invoice_id, project_id, time_entry_id, position, description,
           quantity, unit, tax_rate,
           unit_price_net_cents, line_total_net_cents
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8,
           $9, $10
         )`,
        [
          stornoId,
          item.project_id,
          item.time_entry_id,
          item.position,
          item.description,
          -item.quantity,
          item.unit,
          item.tax_rate,
          item.unit_price_net_cents,
          -item.line_total_net_cents,
        ],
      );
    }

    // Record the storno's birth in the status history so the same audit
    // tooling that shows a normal draft -> issued transition also shows
    // when a storno was created.
    await db.execute(
      `INSERT INTO invoice_status_history (invoice_id, from_status, to_status)
       VALUES ($1, NULL, 'issued')`,
      [stornoId],
    );

    return stornoId;
  });
}
