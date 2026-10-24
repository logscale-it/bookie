import { api, cloud, CloudError, resource } from "$lib/cloud";
import { getDb, withTransaction, safeFields } from "./connection";
import { assertOutsideRetention } from "./retention";
import {
  createInvoiceItem,
  updateInvoiceItem,
  deleteInvoiceItem,
} from "./invoice-items";
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
  | "paid_date"
  | "buyer_reference"
  | "issuer_street"
  | "issuer_postal_code"
  | "issuer_city"
  | "issuer_country_code"
> & {
  // optional: recurring/legacy callers omit them
  buyer_reference?: string | null;
  issuer_street?: string | null;
  issuer_postal_code?: string | null;
  issuer_city?: string | null;
  issuer_country_code?: string | null;
};
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
  "buyer_reference",
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
  "issuer_street",
  "issuer_postal_code",
  "issuer_city",
  "issuer_country_code",
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

// Cloud: money is integer cents on both sides, so no unit conversion. The
// server owns numbers, totals, status, the issuer snapshot and storno columns;
// the client sends only these header fields and the raw items.
const REMOTE_HEADER = [
  "customer_id",
  "project_id",
  "issue_date",
  "due_date",
  "delivery_date",
  "service_period_start",
  "service_period_end",
  "currency",
  "recipient_name",
  "recipient_street",
  "recipient_postal_code",
  "recipient_city",
  "recipient_country_code",
  "buyer_reference",
  "notes",
  "language",
  "legal_country_code",
  "due_surcharge",
] as const;
const remote = resource<InvoiceWithCustomer>("invoices");
const toRemote = (data: UpdateInvoice) =>
  Object.fromEntries(safeFields(data, REMOTE_HEADER));
// Drafts carry a server placeholder number ("draft-<uuid>") until /issue.
const fromRemote = <T extends Invoice>({
  items: _,
  ...inv
}: T & { items?: unknown }) =>
  (inv.status === "draft" && inv.invoice_number.startsWith("draft-")
    ? { ...inv, invoice_number: "" }
    : inv) as T;
const remoteItems = (items: InvoiceItemInput[]) =>
  items.map(
    ({
      position,
      description,
      quantity,
      unit,
      unit_price_net_cents,
      tax_rate,
    }) => ({
      position,
      description,
      quantity,
      unit,
      unit_price_net_cents,
      tax_rate,
    }),
  );

/** Cloud: the status moves the server allows (draft -> sent is the issue step). */
const CLOUD_MOVES: Record<string, string[]> = {
  draft: ["sent"],
  sent: ["paid", "void"],
  paid: ["sent"],
};
export const canChangeStatus = (from: string, to: string) =>
  !cloud() || from === to || (CLOUD_MOVES[from]?.includes(to) ?? false);

/** Cloud only: draft -> sent; the server assigns the number and snapshots issuer + recipient. */
export async function issueInvoice(id: number): Promise<Invoice> {
  return fromRemote(
    await api<Invoice>(`/api/invoices/${id}/issue`, "POST", {}),
  );
}

export async function listInvoices(
  companyId: number,
  opts?: { limit?: number; offset?: number },
): Promise<PageResult<Invoice>> {
  // COUNT(*) OVER() computes the total in a single pass without a second round-trip.
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  if (cloud()) {
    const page = await remote.page(limit, offset);
    return { ...page, rows: page.rows.map(fromRemote) };
  }
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
  if (cloud()) {
    const inv = await remote.get(id);
    return inv && fromRemote(inv);
  }
  const db = await getDb();
  const rows = await db.select<Invoice[]>(
    "SELECT * FROM invoices WHERE id = $1",
    [id],
  );
  return rows[0];
}

export async function createInvoice(data: CreateInvoice): Promise<number> {
  if (cloud()) return remote.create(toRemote(data)); // always a draft, items via syncInvoiceItems
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO invoices (company_id, customer_id, project_id, invoice_number, status, issue_date, due_date, service_period_start, service_period_end, currency, net_cents, tax_cents, gross_cents, issuer_name, issuer_tax_number, issuer_vat_id, issuer_bank_account_holder, issuer_bank_iban, issuer_bank_bic, issuer_bank_name, recipient_name, recipient_street, recipient_postal_code, recipient_city, recipient_country_code, notes, buyer_reference, issuer_street, issuer_postal_code, issuer_city, issuer_country_code)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)`,
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
      data.buyer_reference ?? null,
      data.issuer_street ?? null,
      data.issuer_postal_code ?? null,
      data.issuer_city ?? null,
      data.issuer_country_code ?? null,
    ],
  );
  return result.lastInsertId!;
}

export async function updateInvoice(
  id: number,
  data: UpdateInvoice,
): Promise<void> {
  if (cloud()) {
    const patch = toRemote(data);
    // s3_key-only updates have nothing to send (S3 archival is desktop-only).
    return Object.keys(patch).length ? remote.update(id, patch) : undefined;
  }
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

export type InvoiceItemInput = Pick<
  InvoiceItem,
  | "position"
  | "description"
  | "quantity"
  | "unit"
  | "unit_price_net_cents"
  | "tax_rate"
  | "line_total_net_cents"
> & { id?: number };

/**
 * Sync an invoice's line items to `items`: delete the ones no longer listed,
 * update only those that differ from `existing` (each UPDATE writes an
 * invoice_audit row), insert the new ones. Runs on the shared connection, so
 * wrap the caller's whole save in `withTransaction` for a single commit.
 */
export async function syncInvoiceItems(
  invoiceId: number,
  items: InvoiceItemInput[],
  existing: InvoiceItem[] = [],
): Promise<void> {
  // Cloud: PATCH items replaces all of them; the server computes line totals.
  if (cloud()) return remote.update(invoiceId, { items: remoteItems(items) });
  const keep = new Set(items.map((i) => i.id));
  for (const old of existing) {
    if (!keep.has(old.id)) await deleteInvoiceItem(old.id);
  }
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const { id, ...data } of items) {
    const old = id === undefined ? undefined : byId.get(id);
    if (id === undefined) {
      await createInvoiceItem({
        invoice_id: invoiceId,
        project_id: null,
        time_entry_id: null,
        ...data,
      });
    } else if (
      !old ||
      (Object.keys(data) as (keyof typeof data)[]).some(
        (k) => data[k] !== old[k],
      )
    ) {
      await updateInvoiceItem(id, data);
    }
  }
}

export async function deleteInvoice(id: number): Promise<void> {
  if (cloud()) return remote.remove(id); // server: drafts only, else 409 invoice_immutable
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
  if (cloud()) {
    const page = await remote.page(limit, offset);
    return { ...page, rows: page.rows.map(fromRemote) };
  }
  const db = await getDb();
  const raw = await db.select<
    (InvoiceWithCustomer & { _total_count: number })[]
  >(
    `
		SELECT i.*, c.name AS customer_name, COUNT(*) OVER() AS _total_count
		FROM invoices i
		LEFT JOIN customers c ON i.customer_id = c.id
		ORDER BY i.issue_date DESC LIMIT $1 OFFSET $2
	`,
    [limit, offset],
  );
  const totalCount = raw.length > 0 ? raw[0]._total_count : 0;
  const rows = raw.map(
    ({ _total_count: _, ...rest }) => rest as InvoiceWithCustomer,
  );
  return { rows, totalCount };
}

export type InvoiceSearchItem = Pick<
  InvoiceWithCustomer,
  "id" | "invoice_number" | "customer_name"
>;

/** Slim projection for the command palette: only what it displays/searches. */
export async function listInvoiceSearchItems(
  companyId: number,
  limit = 500,
): Promise<InvoiceSearchItem[]> {
  if (cloud())
    return (await remote.page(limit, 0)).rows
      .map(fromRemote)
      .map(({ id, invoice_number, customer_name }) => ({
        id,
        invoice_number,
        customer_name,
      }));
  const db = await getDb();
  return db.select<InvoiceSearchItem[]>(
    `SELECT i.id, i.invoice_number, c.name AS customer_name
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     WHERE i.company_id = $1
     ORDER BY i.issue_date DESC LIMIT $2`,
    [companyId, limit],
  );
}

export async function updateInvoiceStatus(
  id: number,
  fromStatus: string | null,
  toStatus: string,
): Promise<void> {
  if (cloud()) {
    if (fromStatus === "draft" && toStatus === "sent")
      return void (await issueInvoice(id));
    // paid_date: the server stamps today on -> paid and clears it on paid -> sent.
    return void (await api(`/api/invoices/${id}/status`, "POST", {
      status: toStatus,
    }));
  }
  await withTransaction(async (db) => {
    // paid_date carries the Zufluss date (§ 11 EStG) for the EÜR: stamped on
    // the transition into 'paid' (kept if already set), cleared on the way
    // out so it is non-NULL exactly while the invoice is paid.
    await db.execute(
      `UPDATE invoices
       SET status = $1,
           paid_date = CASE WHEN $1 = 'paid' THEN COALESCE(paid_date, date('now', 'localtime')) END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [toStatus, id],
    );
    await db.execute(
      `INSERT INTO invoice_status_history (invoice_id, from_status, to_status) VALUES ($1, $2, $3)`,
      [id, fromStatus, toStatus],
    );
  });
}

/**
 * Correct the Zufluss date (§ 11 EStG) of a paid invoice — the automatic
 * stamp records when the user clicked, not when the money arrived. Only
 * legal while the invoice is 'paid'; the immutability trigger does not
 * guard paid_date, so this is allowed on issued rows.
 */
export async function updateInvoicePaidDate(
  id: number,
  paidDate: string,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) {
    throw new Error(`Ungültiges Zahlungsdatum: ${paidDate}`);
  }
  if (cloud())
    return void (await api(`/api/invoices/${id}/paid-date`, "POST", {
      paid_date: paidDate,
    }).catch((e) =>
      Promise.reject(
        e instanceof CloudError && e.code === "not_paid"
          ? new Error(
              "Zahlungsdatum kann nur bei bezahlten Rechnungen geändert werden",
            )
          : e,
      ),
    ));
  const db = await getDb();
  const res = await db.execute(
    `UPDATE invoices
     SET paid_date = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND status = 'paid'`,
    [paidDate, id],
  );
  if (res.rowsAffected === 0) {
    throw new Error(
      "Zahlungsdatum kann nur bei bezahlten Rechnungen geändert werden",
    );
  }
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
 * - `status` is `'sent'` — part of the normal status vocabulary
 *   (draft/sent/paid/void), so the storno's negated amounts enter every
 *   revenue/EÜR/UStVA/DATEV query that filters on ('sent','paid') and
 *   offset the original. A row in `invoice_status_history` records the
 *   transition from NULL -> 'sent'.
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
  if (cloud())
    return (
      await api<{ id: number }>(`/api/invoices/${id}/storno`, "POST", {
        reason,
      })
    ).id;
  const original = await getInvoiceById(id);
  if (!original) {
    throw new Error(`Invoice with id ${id} not found`);
  }
  if (original.status === "draft") {
    throw invoiceImmutableError(
      "Entwurfsrechnungen können nicht storniert werden — bitte löschen statt stornieren",
    );
  }

  if (original.references_invoice_id != null) {
    throw invoiceImmutableError(
      "Eine Stornorechnung kann nicht storniert werden",
    );
  }

  return await withTransaction(async (db) => {
    // Once only, like the server: a second full storno would negate the
    // amounts twice. Looked up via the FK column, not LIKE on the number.
    const existingStornos = await db.select<{ id: number }[]>(
      `SELECT id FROM invoices WHERE references_invoice_id = $1 AND company_id = $2`,
      [id, original.company_id],
    );
    if (existingStornos.length > 0) {
      throw invoiceImmutableError("Rechnung ist bereits storniert");
    }
    const stornoNumber = `${original.invoice_number}-storno-1`;
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
         notes, references_invoice_id, cancellation_reason,
         issuer_street, issuer_postal_code, issuer_city, issuer_country_code
       ) VALUES (
         $1, $2, $3, $4, 'sent',
         $5, $6, $7, $8,
         $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18,
         $19,
         $20, $21, $22,
         $23, $24,
         $25, $26, $27, $28,
         $29, $30, $31,
         $32, $33, $34, $35
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
        original.issuer_street,
        original.issuer_postal_code,
        original.issuer_city,
        original.issuer_country_code,
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
       VALUES ($1, NULL, 'sent')`,
      [stornoId],
    );

    return stornoId;
  });
}

/**
 * Cloud only: a draft from the customer's approved, billable, not yet
 * invoiced time entries (one item per entry, priced at the project's hourly
 * rate). The server answers 400 no_entries when nothing matches.
 * @returns the new draft's id.
 */
export async function createInvoiceFromTimeEntries(opts: {
  customer_id: number;
  project_id?: number | null;
  from?: string | null;
  to?: string | null;
}): Promise<number> {
  if (!cloud())
    throw new Error("Rechnung aus Zeiteinträgen gibt es nur in bookie Cloud");
  const body = Object.fromEntries(
    Object.entries(opts).filter(([, v]) => v != null && v !== ""),
  );
  return (
    await api<{ id: number }>("/api/invoices/from-time-entries", "POST", body)
  ).id;
}
