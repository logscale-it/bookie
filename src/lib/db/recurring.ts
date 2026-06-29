import { getDb } from "./connection";
import { createInvoice, getInvoiceById } from "./invoices";
import { createInvoiceItem, listByInvoice } from "./invoice-items";
import {
  createIncomingInvoice,
  getIncomingInvoiceById,
} from "./incoming-invoices";
import { getInvoiceSettings, saveInvoiceSettings } from "./settings";
import { generateInvoiceNumber } from "../invoice-number";
import { advance, addDays, type Frequency } from "../recurrence";
import type { RecurringEntry } from "./types";

// The `payload` JSON for a schedule is the snapshot of an existing entry's
// create-arguments. Run-specific fields (dates, fresh invoice number, status)
// are filled by the generator at materialisation time, so the snapshot is
// intentionally date-agnostic — we keep whatever date the source had and
// overwrite it on every run.
type InvoicePayload = {
  invoice: Record<string, unknown>;
  items: Record<string, unknown>[];
};
type IncomingPayload = Record<string, unknown>;

export type NewRecurring = {
  company_id: number;
  kind: "invoice" | "incoming";
  label: string;
  frequency: Frequency;
  interval_count: number;
  next_run_date: string;
  end_date: string | null;
  payload: InvoicePayload | IncomingPayload;
};

export async function listRecurring(
  companyId: number,
): Promise<RecurringEntry[]> {
  const db = await getDb();
  return db.select<RecurringEntry[]>(
    `SELECT * FROM recurring_entries WHERE company_id = $1
     ORDER BY active DESC, next_run_date ASC`,
    [companyId],
  );
}

export async function createRecurring(data: NewRecurring): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO recurring_entries
       (company_id, kind, label, frequency, interval_count, next_run_date, end_date, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      data.company_id,
      data.kind,
      data.label,
      data.frequency,
      data.interval_count,
      data.next_run_date,
      data.end_date,
      JSON.stringify(data.payload),
    ],
  );
  return result.lastInsertId!;
}

export async function setRecurringActive(
  id: number,
  active: boolean,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE recurring_entries SET active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [active ? 1 : 0, id],
  );
}

export async function deleteRecurring(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM recurring_entries WHERE id = $1", [id]);
}

// --- snapshot builders: turn an existing entry into a reusable payload ---

export async function snapshotInvoice(
  invoiceId: number,
): Promise<{ label: string; payload: InvoicePayload }> {
  const inv = await getInvoiceById(invoiceId);
  if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
  const { rows: items } = await listByInvoice(invoiceId);
  const invoice = {
    company_id: inv.company_id,
    customer_id: inv.customer_id,
    project_id: inv.project_id,
    currency: inv.currency,
    net_cents: inv.net_cents,
    tax_cents: inv.tax_cents,
    gross_cents: inv.gross_cents,
    service_period_start: inv.service_period_start,
    service_period_end: inv.service_period_end,
    issuer_name: inv.issuer_name,
    issuer_tax_number: inv.issuer_tax_number,
    issuer_vat_id: inv.issuer_vat_id,
    issuer_bank_account_holder: inv.issuer_bank_account_holder,
    issuer_bank_iban: inv.issuer_bank_iban,
    issuer_bank_bic: inv.issuer_bank_bic,
    issuer_bank_name: inv.issuer_bank_name,
    recipient_name: inv.recipient_name,
    recipient_street: inv.recipient_street,
    recipient_postal_code: inv.recipient_postal_code,
    recipient_city: inv.recipient_city,
    recipient_country_code: inv.recipient_country_code,
    notes: inv.notes,
    due_surcharge: inv.due_surcharge,
    language: inv.language,
    legal_country_code: inv.legal_country_code,
  };
  const itemPayload = items.map((it) => ({
    project_id: it.project_id,
    time_entry_id: it.time_entry_id,
    position: it.position,
    description: it.description,
    quantity: it.quantity,
    unit: it.unit,
    unit_price_net_cents: it.unit_price_net_cents,
    tax_rate: it.tax_rate,
    line_total_net_cents: it.line_total_net_cents,
  }));
  return {
    label: inv.invoice_number,
    payload: { invoice, items: itemPayload },
  };
}

export async function snapshotIncoming(
  incomingId: number,
): Promise<{ label: string; payload: IncomingPayload }> {
  const inc = await getIncomingInvoiceById(incomingId);
  if (!inc) throw new Error(`Incoming invoice ${incomingId} not found`);
  const payload: IncomingPayload = {
    company_id: inc.company_id,
    supplier_id: inc.supplier_id,
    invoice_number: inc.invoice_number,
    net_cents: inc.net_cents,
    tax_cents: inc.tax_cents,
    status: "offen",
    // Attachments are not duplicated across generated copies — a recurring
    // cost (rent, subscription) re-states the same amount, not the same PDF.
    file_name: null,
    file_type: null,
    s3_key: null,
    local_path: null,
    notes: inc.notes,
  };
  return { label: inc.invoice_number ?? inc.notes ?? "Kosten", payload };
}

// --- generation engine ---

// Bound the catch-up loop so a schedule whose next_run is far in the past
// (e.g. imported, or the app wasn't opened for a year) can't spawn an
// unbounded number of entries in one boot. 120 ≈ 10 years of monthly runs.
const MAX_CATCHUP = 120;

async function materialiseInvoice(
  payload: InvoicePayload,
  runDate: string,
): Promise<void> {
  const settings = await getInvoiceSettings();
  const number = generateInvoiceNumber(
    settings.invoice_number_format,
    settings.invoice_number_incrementor,
  );
  const invoiceId = await createInvoice({
    ...(payload.invoice as Record<string, never>),
    invoice_number: number,
    status: "draft",
    issue_date: runDate,
    delivery_date: runDate,
    due_date: addDays(runDate, settings.days_till_due),
    s3_key: null,
  } as Parameters<typeof createInvoice>[0]);
  for (const item of payload.items) {
    await createInvoiceItem({
      ...(item as Record<string, never>),
      invoice_id: invoiceId,
    } as Parameters<typeof createInvoiceItem>[0]);
  }
  await saveInvoiceSettings({
    ...settings,
    invoice_number_incrementor: settings.invoice_number_incrementor + 1,
  });
}

async function materialiseIncoming(
  payload: IncomingPayload,
  runDate: string,
): Promise<void> {
  await createIncomingInvoice({
    ...(payload as Record<string, never>),
    invoice_date: runDate,
  } as Parameters<typeof createIncomingInvoice>[0]);
}

/**
 * Generate every entry that is due on or before `today` for all active
 * schedules of `companyId`, advancing each schedule's `next_run_date` past
 * `today` (and deactivating it once it passes its `end_date`). Idempotent
 * across boots: an entry is only generated when `next_run_date <= today`, and
 * the cursor is persisted after each schedule, so re-running on the same day
 * produces nothing new.
 *
 * @returns the number of entries generated.
 */
export async function runDueRecurring(
  companyId: number,
  today: string,
): Promise<number> {
  const db = await getDb();
  const due = await db.select<RecurringEntry[]>(
    `SELECT * FROM recurring_entries
     WHERE company_id = $1 AND active = 1 AND next_run_date <= $2`,
    [companyId, today],
  );

  let generated = 0;
  for (const r of due) {
    let next = r.next_run_date;
    let last = r.last_run_date;
    let guard = 0;
    while (
      next <= today &&
      (!r.end_date || next <= r.end_date) &&
      guard < MAX_CATCHUP
    ) {
      if (r.kind === "invoice") {
        await materialiseInvoice(JSON.parse(r.payload) as InvoicePayload, next);
      } else {
        await materialiseIncoming(
          JSON.parse(r.payload) as IncomingPayload,
          next,
        );
      }
      last = next;
      next = advance(next, r.frequency, r.interval_count);
      generated++;
      guard++;
    }
    const exhausted = r.end_date != null && next > r.end_date;
    await db.execute(
      `UPDATE recurring_entries
       SET next_run_date = $1, last_run_date = $2, active = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [next, last, exhausted ? 0 : 1, r.id],
    );
  }
  return generated;
}
