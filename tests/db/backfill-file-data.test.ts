/**
 * DAT-5.a — backfill `incoming_invoices.file_data` -> S3 or local disk.
 *
 * The backfill runs against a real (in-memory) SQLite + the production
 * migration set, but mocks out the two side-effect boundaries (the Tauri
 * `invoke` channel and the S3 client `uploadFile`) so we don't need MinIO
 * or a real `window.__TAURI_INTERNALS__`.
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";

// State the mocks read/write per-test. Reassigning it (vs. mutating in
// place) would break the closure the mock factories captured below —
// so we mutate fields on this object instead.
const fixture: {
  s3Settings: {
    enabled: number;
    endpoint_url: string;
    region: string;
    bucket_name: string;
    access_key_id: string;
    secret_access_key: string;
    path_prefix: string;
    auto_backup_enabled: number;
    last_auto_backup_at: string | null;
  };
  appDataDir: string;
  uploads: { prefix: string; name: string; bytes: Uint8Array }[];
  writes: { path: string; bytes: number[] }[];
  uploadFails: Set<string>;
} = {
  s3Settings: {
    enabled: 0,
    endpoint_url: "",
    region: "eu-central-1",
    bucket_name: "",
    access_key_id: "",
    secret_access_key: "",
    path_prefix: "rechnungen",
    auto_backup_enabled: 0,
    last_auto_backup_at: null,
  },
  appDataDir: "/tmp/bookie-test",
  uploads: [],
  writes: [],
  uploadFails: new Set(),
};

// Mock the Tauri invoke boundary BEFORE importing anything that pulls it
// in transitively. Two commands are exercised by the backfill:
//   - `get_app_data_dir` (added by this PR), and
//   - `write_binary_file` (existing).
// Plus `get_s3_credentials` from getS3Settings — surfaced as no_entry so
// the settings layer falls back to the row data only.
// In-test keyring substitute — saveS3Settings calls `store_s3_credentials`
// when creds are set, and getS3Settings calls `get_s3_credentials` when
// reading. Keep both paths in sync so the persisted row's credentials
// look real to `isS3Usable` after a write+read cycle.
const fakeKeyring: {
  creds: { accessKeyId: string; secretAccessKey: string } | null;
} = { creds: null };

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    if (cmd === "get_app_data_dir") return fixture.appDataDir;
    if (cmd === "write_binary_file") {
      const a = args as { path: string; data: number[] };
      fixture.writes.push({ path: a.path, bytes: a.data });
      return;
    }
    if (cmd === "store_s3_credentials") {
      const a = args as { accessKeyId: string; secretAccessKey: string };
      fakeKeyring.creds = {
        accessKeyId: a.accessKeyId,
        secretAccessKey: a.secretAccessKey,
      };
      return;
    }
    if (cmd === "get_s3_credentials") {
      if (!fakeKeyring.creds) throw new Error("no_entry");
      return fakeKeyring.creds;
    }
    if (cmd === "delete_s3_credentials") {
      fakeKeyring.creds = null;
      return;
    }
    throw new Error(`unmocked invoke: ${cmd}`);
  },
}));

// Mock the S3 client so we don't need a real bucket. `uploadFile` returns
// the resulting key, mirroring the production contract.
mock.module("../../src/lib/s3/client", () => ({
  uploadFile: async (
    _settings: unknown,
    prefix: string,
    name: string,
    data: Uint8Array,
  ): Promise<string> => {
    if (fixture.uploadFails.has(name)) throw new Error("network");
    fixture.uploads.push({ prefix, name, bytes: data });
    return prefix ? `${prefix}/${name}` : name;
  },
}));

import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as ii from "../../src/lib/db/incoming-invoices";
import {
  backfillIncomingInvoiceFileData,
  isS3Usable,
  joinPath,
  LOCAL_DIR,
} from "../../src/lib/db/backfill-file-data";
import * as settings from "../../src/lib/db/settings";
import { getDb } from "../../src/lib/db/connection";

let counter = 0;
async function seed() {
  counter++;
  const companyId = await companies.createCompany({
    name: `Co-${counter}`,
    legal_name: null,
    street: null,
    postal_code: null,
    city: null,
    country_code: "DE",
    tax_number: null,
    vat_id: null,
    bank_account_holder: null,
    bank_iban: null,
    bank_bic: null,
    bank_name: null,
  });
  const supplierId = await customers.createCustomer({
    company_id: companyId,
    customer_number: null,
    name: "Supplier Co",
    contact_name: null,
    email: null,
    phone: null,
    street: null,
    postal_code: null,
    city: null,
    country_code: "DE",
    vat_id: null,
    website: null,
    type: "lieferant",
  });
  return { companyId, supplierId };
}

async function rawInsert(opts: {
  companyId: number;
  supplierId: number | null;
  invoiceNumber: string;
  fileData: number[] | null;
  fileName: string | null;
  s3Key: string | null;
  localPath: string | null;
}): Promise<number> {
  // Bypass createIncomingInvoice so we can plant a row that already has
  // file_data populated (the production wrapper accepts file_data, but
  // hand-writing the INSERT keeps the test focused on what the backfill
  // sees and avoids re-asserting all the *_cents fields).
  const db = await getDb();
  const r = await db.execute(
    `INSERT INTO incoming_invoices (
       company_id, supplier_id, invoice_number, invoice_date,
       net_amount, tax_amount, gross_amount,
       net_cents, tax_cents, gross_cents,
       status, file_data, file_name, file_type, s3_key, local_path, notes
     ) VALUES ($1, $2, $3, '2026-04-15', 0, 0, 0,
              10000, 1900, 11900, 'offen', $4, $5, 'application/pdf',
              $6, $7, NULL)`,
    [
      opts.companyId,
      opts.supplierId,
      opts.invoiceNumber,
      // bun:sqlite stores Uint8Array as a BLOB; null stays null.
      opts.fileData ? new Uint8Array(opts.fileData) : null,
      opts.fileName,
      opts.s3Key,
      opts.localPath,
    ],
  );
  return r.lastInsertId!;
}

const S3_DISABLED = {
  enabled: 0,
  endpoint_url: "",
  region: "eu-central-1",
  bucket_name: "",
  access_key_id: "",
  secret_access_key: "",
  path_prefix: "rechnungen",
  auto_backup_enabled: 0,
  last_auto_backup_at: null,
};

const S3_ENABLED = {
  enabled: 1,
  endpoint_url: "https://s3.example.com",
  region: "eu-central-1",
  bucket_name: "bookie-test",
  access_key_id: "AKIA",
  secret_access_key: "secret",
  path_prefix: "rechnungen",
  auto_backup_enabled: 0,
  last_auto_backup_at: null,
};

beforeEach(() => {
  fixture.s3Settings = { ...S3_DISABLED };
  fixture.uploads = [];
  fixture.writes = [];
  fixture.uploadFails = new Set();
  fakeKeyring.creds = null;
});

/** Persist S3 settings to the in-memory DB so getS3Settings() reads them. */
async function applyS3(s: typeof S3_DISABLED) {
  fixture.s3Settings = s;
  await settings.saveS3Settings(s);
}

describe("backfill incoming_invoices.file_data — DAT-5.a", () => {
  test("isS3Usable requires enabled + bucket + creds", () => {
    expect(isS3Usable(S3_DISABLED)).toBe(false);
    expect(isS3Usable(S3_ENABLED)).toBe(true);
    expect(isS3Usable({ ...S3_ENABLED, enabled: 0 })).toBe(false);
    expect(isS3Usable({ ...S3_ENABLED, bucket_name: "" })).toBe(false);
    expect(isS3Usable({ ...S3_ENABLED, secret_access_key: "" })).toBe(false);
  });

  test("joinPath joins with a single separator regardless of trailing slash", () => {
    expect(joinPath("/tmp/a", "b")).toBe("/tmp/a/b");
    expect(joinPath("/tmp/a/", "b")).toBe("/tmp/a/b");
    expect(joinPath("C:\\app\\", "b")).toBe("C:\\app\\b");
  });

  test("LOCAL_DIR matches the spec from issue #65", () => {
    expect(LOCAL_DIR).toBe("incoming_invoices");
  });

  test("local target writes file, sets local_path, NULLs file_data", async () => {
    await applyS3(S3_DISABLED);
    const { companyId, supplierId } = await seed();
    const id = await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "S-LOCAL",
      fileData: [1, 2, 3, 4],
      fileName: "rechnung.pdf",
      s3Key: null,
      localPath: null,
    });

    const result = await backfillIncomingInvoiceFileData();

    expect(result.target).toBe("local");
    expect(result.candidates).toBe(1);
    expect(result.migrated).toBe(1);
    expect(result.errors).toEqual([]);

    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0].path).toBe(
      `/tmp/bookie-test/incoming_invoices/${id}.pdf`,
    );
    expect(fixture.writes[0].bytes).toEqual([1, 2, 3, 4]);

    const after = await ii.getIncomingInvoiceFile(id);
    expect(after?.local_path).toBe(
      `/tmp/bookie-test/incoming_invoices/${id}.pdf`,
    );
    expect(after?.s3_key).toBeNull();
    expect(after?.file_data).toBeNull();
  });

  test("s3 target uploads, sets s3_key, NULLs file_data", async () => {
    await applyS3(S3_ENABLED);
    const { companyId, supplierId } = await seed();
    const id = await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "S-S3",
      fileData: [9, 9, 9],
      fileName: "rechnung.pdf",
      s3Key: null,
      localPath: null,
    });

    const result = await backfillIncomingInvoiceFileData();

    expect(result.target).toBe("s3");
    expect(result.migrated).toBe(1);
    expect(result.errors).toEqual([]);
    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.uploads[0]).toMatchObject({
      prefix: "rechnungen",
      name: "rechnung.pdf",
    });
    expect(Array.from(fixture.uploads[0].bytes)).toEqual([9, 9, 9]);

    const after = await ii.getIncomingInvoiceFile(id);
    expect(after?.s3_key).toBe("rechnungen/rechnung.pdf");
    expect(after?.local_path).toBeNull();
    expect(after?.file_data).toBeNull();
  });

  test("s3 target falls back to incoming-<id>.pdf when file_name is NULL", async () => {
    await applyS3(S3_ENABLED);
    const { companyId, supplierId } = await seed();
    const id = await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "S-NONAME",
      fileData: [1],
      fileName: null,
      s3Key: null,
      localPath: null,
    });
    await backfillIncomingInvoiceFileData();
    expect(fixture.uploads[0].name).toBe(`incoming-${id}.pdf`);
  });

  test("idempotent: rows with s3_key OR local_path already set are skipped", async () => {
    await applyS3(S3_DISABLED);
    const { companyId, supplierId } = await seed();
    await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "ALREADY-S3",
      fileData: [1, 2],
      fileName: "x.pdf",
      s3Key: "rechnungen/x.pdf",
      localPath: null,
    });
    await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "ALREADY-LOCAL",
      fileData: [3, 4],
      fileName: "y.pdf",
      s3Key: null,
      localPath: "/tmp/y.pdf",
    });
    await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "NO-FILE",
      fileData: null,
      fileName: null,
      s3Key: null,
      localPath: null,
    });

    const result = await backfillIncomingInvoiceFileData();
    expect(result.candidates).toBe(0);
    expect(result.migrated).toBe(0);
    expect(fixture.writes).toHaveLength(0);
  });

  test("upload failure leaves file_data intact and is reported per-row", async () => {
    await applyS3(S3_ENABLED);
    fixture.uploadFails.add("fail.pdf");
    const { companyId, supplierId } = await seed();
    const okId = await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "OK",
      fileData: [1, 2, 3],
      fileName: "ok.pdf",
      s3Key: null,
      localPath: null,
    });
    const failId = await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "FAIL",
      fileData: [9, 9],
      fileName: "fail.pdf",
      s3Key: null,
      localPath: null,
    });

    const result = await backfillIncomingInvoiceFileData();
    expect(result.candidates).toBe(2);
    expect(result.migrated).toBe(1);
    expect(result.errors).toEqual([{ id: failId, error: "network" }]);

    const okAfter = await ii.getIncomingInvoiceFile(okId);
    expect(okAfter?.s3_key).toBe("rechnungen/ok.pdf");
    expect(okAfter?.file_data).toBeNull();

    const failAfter = await ii.getIncomingInvoiceFile(failId);
    expect(failAfter?.s3_key).toBeNull();
    expect(failAfter?.local_path).toBeNull();
    expect(failAfter?.file_data).not.toBeNull();
  });

  test("post-run verification: no row keeps file_data, every filed row has s3_key or local_path", async () => {
    await applyS3(S3_DISABLED);
    const { companyId, supplierId } = await seed();
    await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "A",
      fileData: [1],
      fileName: "a.pdf",
      s3Key: null,
      localPath: null,
    });
    await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "B",
      fileData: [2],
      fileName: "b.pdf",
      s3Key: null,
      localPath: null,
    });
    await rawInsert({
      companyId,
      supplierId,
      invoiceNumber: "C",
      fileData: null,
      fileName: null,
      s3Key: null,
      localPath: null,
    });

    await backfillIncomingInvoiceFileData();

    // Literal verification clause from the issue:
    //   SELECT COUNT(*) FROM incoming_invoices WHERE file_data IS NOT NULL = 0
    //   AND every row has either s3_key or local_path.
    const db = await getDb();
    const blobLeft = await db.select<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM incoming_invoices WHERE file_data IS NOT NULL`,
    );
    expect(blobLeft[0].c).toBe(0);

    const orphan = await db.select<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM incoming_invoices
       WHERE file_name IS NOT NULL
         AND s3_key IS NULL
         AND local_path IS NULL`,
    );
    expect(orphan[0].c).toBe(0);
  });
});
