// One-time move of the local SQLite data into a fresh, empty bookie Cloud
// company (bookie-server POST /api/import). Reads the local file directly
// (getLocalDb, also in cloud mode) and never writes to it. Local ids only link
// rows inside the document; the server assigns new ones. Issued invoices go
// over as stored (number, totals, issuer snapshot), the server does not
// recompute them. Rows go over as SELECT *: the server picks the columns it
// knows and ignores the rest (company_id, timestamps, s3_key, ...).

import { invoke } from "@tauri-apps/api/core";
import { api, CloudError } from "$lib/cloud";
import { getLocalDb } from "$lib/db/connection";
import { attachReceipt } from "$lib/db/incoming-invoices";
import {
  getS3Settings,
  readOrganizationSettings,
  saveOrganizationSettings,
} from "$lib/db/settings";
import { messageForUnknown } from "$lib/shared/errors";
import { t } from "$lib/i18n";
import { buildConfig } from "$lib/s3/client";

type Row = Record<string, unknown>;
type Db = { select<T>(sql: string, params?: unknown[]): Promise<T> };

export type ImportDocument = {
  settings?: Row;
  vat_taxes: Row[];
  customers: Row[];
  projects: Row[];
  time_entries: Row[];
  invoices: Row[];
  incoming_invoices: Row[];
  recurring_entries: Row[];
};
export type ImportCounts = {
  [K in Exclude<keyof ImportDocument, "settings">]: number;
};

/** Not transferred. */
export const skipped = () => [t("cloudImport.skippedS3")];

const byInvoice = (rows: Row[]) => {
  const m = new Map<unknown, Row[]>();
  for (const r of rows) {
    if (!m.has(r.invoice_id)) m.set(r.invoice_id, []);
    m.get(r.invoice_id)!.push(r);
  }
  return m;
};

/** The company the app shows: the first by name. */
const firstCompany = async (db: Db) =>
  (await db.select<Row[]>("SELECT id FROM companies ORDER BY name LIMIT 1"))[0]
    ?.id ?? null;

/** The local data of the first company (the one the app shows) as an import document. */
export async function buildImport(db: Db): Promise<ImportDocument> {
  const sel = (sql: string, params: unknown[] = []) =>
    db.select<Row[]>(sql, params);
  const cid = await firstCompany(db);
  const [inv] = await sel("SELECT * FROM settings_invoice WHERE id = 1");
  // Locale, e-invoice and DATEV keys live in settings_organization locally.
  const [org] = await sel("SELECT * FROM settings_organization WHERE id = 1");
  const items = byInvoice(
    await sel(
      `SELECT ii.* FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.company_id = $1 ORDER BY ii.position, ii.id`,
      [cid],
    ),
  );
  const payments = byInvoice(
    await sel(
      `SELECT p.* FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.company_id = $1 ORDER BY p.payment_date, p.id`,
      [cid],
    ),
  );
  const history = byInvoice(
    await sel(
      `SELECT h.* FROM invoice_status_history h JOIN invoices i ON i.id = h.invoice_id
       WHERE i.company_id = $1 ORDER BY h.changed_at, h.id`,
      [cid],
    ),
  );
  const rows = (table: string) =>
    sel(`SELECT * FROM ${table} WHERE company_id = $1 ORDER BY id`, [cid]);

  return {
    settings: inv || org ? { ...inv, ...org } : undefined,
    vat_taxes: await sel("SELECT * FROM vat_taxes ORDER BY id"),
    customers: await rows("customers"),
    // Server keeps money in cents; the desktop has euros in hourly_rate.
    projects: (await rows("projects")).map(({ hourly_rate, ...p }) => ({
      ...p,
      hourly_rate_cents:
        hourly_rate == null ? null : Math.round(Number(hourly_rate) * 100),
    })),
    time_entries: await rows("time_entries"),
    // By id: a storno comes after the invoice it references.
    invoices: (await rows("invoices")).map((i) => ({
      ...i,
      items: items.get(i.id) ?? [],
      payments: payments.get(i.id) ?? [],
      status_history: history.get(i.id) ?? [],
    })),
    // Metadata only (s3_key/local_path are ignored by the server); pushReceipts moves the files.
    incoming_invoices: await rows("incoming_invoices"),
    recurring_entries: await rows("recurring_entries"),
  };
}

export const countsOf = (d: ImportDocument): ImportCounts => ({
  vat_taxes: d.vat_taxes.length,
  customers: d.customers.length,
  projects: d.projects.length,
  time_entries: d.time_entries.length,
  invoices: d.invoices.length,
  incoming_invoices: d.incoming_invoices.length,
  recurring_entries: d.recurring_entries.length,
});

export const readLocalImport = async () => buildImport(await getLocalDb());

export async function pushImport(doc: ImportDocument): Promise<ImportCounts> {
  try {
    return await api<ImportCounts>("/api/import", "POST", doc);
  } catch (e) {
    if (e instanceof CloudError && e.status === 413)
      throw new Error(
        "Die lokalen Daten sind zu groß für eine Übertragung (max. 1 MB). Bitte den Support kontaktieren.",
      );
    throw e;
  }
}

/** Company master data (address, bank, tax ids) via the existing cloud save. */
export const pushOrganization = async () =>
  saveOrganizationSettings(await readOrganizationSettings(await getLocalDb()));

// The import gives no id mapping, so a local incoming invoice is found in the
// cloud by its content; equal rows pair up in id order on both sides.
const incomingKey = (r: Row) =>
  JSON.stringify([
    r.supplier_name ?? null,
    r.invoice_number || null,
    r.invoice_date,
    Number(r.net_cents),
    Number(r.tax_cents),
    r.notes || null,
  ]);

/** Pairs every local row that has a receipt with its cloud twin that still has none. */
export function pairReceipts(local: Row[], remote: Row[]): [Row, Row][] {
  const byKey = new Map<string, Row[]>();
  for (const r of [...remote].sort((a, b) => Number(a.id) - Number(b.id))) {
    const k = incomingKey(r);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const pairs: [Row, Row][] = [];
  for (const l of [...local].sort((a, b) => Number(a.id) - Number(b.id))) {
    const twin = byKey.get(incomingKey(l))?.shift();
    if (twin && (l.s3_key || l.local_path) && !twin.s3_key)
      pairs.push([l, twin]);
  }
  return pairs;
}

export type ReceiptProgress = { done: number; total: number };

// Receipts in flight at once. Each one streams from source to cloud bucket in
// Rust (a few buffers of RAM whatever its size), so only the count is bounded.
const PARALLEL = 8;

/**
 * Copies the receipt files of the local incoming invoices (local S3 bucket or
 * disk) onto their cloud twins, PARALLEL at a time. The bytes stream from
 * source to cloud bucket inside Rust (copy_receipt): never via the webview,
 * never onto the disk. Repeatable: twins that have a receipt are skipped.
 */
export async function pushReceipts(
  onProgress: (p: ReceiptProgress) => void = () => {},
): Promise<{ done: number; failed: string[] }> {
  const db = await getLocalDb();
  const local = await db.select<Row[]>(
    `SELECT ii.*, c.name AS supplier_name FROM incoming_invoices ii
     LEFT JOIN customers c ON c.id = ii.supplier_id WHERE ii.company_id = $1`,
    [await firstCompany(db)],
  );
  const pairs = pairReceipts(local, await api<Row[]>("/api/incoming-invoices"));
  const s3 = pairs.some(([l]) => l.s3_key)
    ? buildConfig(await getS3Settings(true, db))
    : undefined;
  const source = (l: Row) =>
    l.s3_key
      ? { kind: "s3", config: s3, key: String(l.s3_key) }
      : { kind: "file", path: String(l.local_path) };

  let next = 0;
  let finished = 0;
  let done = 0;
  const failed: string[] = [];
  onProgress({ done: 0, total: pairs.length });
  const worker = async () => {
    while (next < pairs.length) {
      const [l, r] = pairs[next++];
      try {
        const src = source(l);
        const size = await invoke<number>("receipt_size", { source: src });
        await attachReceipt(
          Number(r.id),
          {
            content_type: String(l.file_type || "application/pdf"),
            size,
            file_name: String(l.file_name || "Beleg"),
          },
          (url, contentType) =>
            invoke("copy_receipt", { source: src, size, url, contentType }),
        );
        done++;
      } catch (e) {
        failed.push(
          `${l.supplier_name ?? "?"} ${l.invoice_date} (${l.file_name ?? ""}): ${messageForUnknown(e)}`,
        );
      }
      onProgress({ done: ++finished, total: pairs.length });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, pairs.length) }, worker),
  );
  return { done, failed };
}
