import { test, expect, describe, mock } from "bun:test";

// Mock the keyring boundary BEFORE importing the settings module.
// This is the only edge to the Tauri runtime in the settings layer.
const keyring: { creds: { accessKeyId: string; secretAccessKey: string } | null } = {
  creds: null,
};
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    if (cmd === "store_s3_credentials") {
      const a = args as { accessKeyId: string; secretAccessKey: string };
      keyring.creds = { accessKeyId: a.accessKeyId, secretAccessKey: a.secretAccessKey };
      return;
    }
    if (cmd === "get_s3_credentials") {
      if (!keyring.creds) throw new Error("no_entry");
      return keyring.creds;
    }
    if (cmd === "delete_s3_credentials") {
      keyring.creds = null;
      return;
    }
    throw new Error(`unmocked invoke: ${cmd}`);
  },
}));

import "./setup";
import * as settings from "../../src/lib/db/settings";
import { testDb } from "./setup";

describe("organization settings", () => {
  test("returns defaults when nothing saved", async () => {
    const got = await settings.getOrganizationSettings();
    expect(got.name).toBe("");
    expect(got.default_locale).toBe("de");
    expect(got.default_legal_country).toBe("DE");
  });

  test("upserts on id=1 (insert then update)", async () => {
    await settings.saveOrganizationSettings({
      name: "First", country: "DE", address: "", street: "Str 1",
      postal_code: "10115", city: "Berlin", email: "a@b.de", phone_number: "",
      registering_id: "", bank_name: "", bank_iban: "", bank_account_holder: "",
      vatin: "", website: "", default_locale: "de", default_legal_country: "DE",
    });
    let got = await settings.getOrganizationSettings();
    expect(got.name).toBe("First");

    await settings.saveOrganizationSettings({
      ...got, name: "Updated",
    });
    got = await settings.getOrganizationSettings();
    expect(got.name).toBe("Updated");

    const rows = await testDb.select<{ count: number }[]>(
      "SELECT COUNT(*) AS count FROM settings_organization",
    );
    expect(rows[0].count).toBe(1);
  });
});

describe("invoice settings", () => {
  test("returns defaults when nothing saved", async () => {
    const got = await settings.getInvoiceSettings();
    expect(got.currency).toBe("EUR");
    expect(got.days_till_due).toBe(14);
  });

  test("upserts and persists", async () => {
    await settings.saveInvoiceSettings({
      currency: "EUR", decimal_places: 2, days_till_due: 30, due_surcharge: 5,
      notes: "hi", invoice_number_format: "RE-{YYYY}-{COUNT}",
      invoice_number_incrementor: 42, company_logo_data_url: null,
    });
    const got = await settings.getInvoiceSettings();
    expect(got.days_till_due).toBe(30);
    expect(got.invoice_number_incrementor).toBe(42);
  });
});

describe("S3 settings", () => {
  test("never writes credentials to DB; stores them in keyring", async () => {
    keyring.creds = null;
    await settings.saveS3Settings({
      enabled: 1, endpoint_url: "https://s3.example.com", region: "eu-central-1",
      bucket_name: "bookie-test", access_key_id: "AKIA",
      secret_access_key: "SECRET", path_prefix: "rechnungen",
      auto_backup_enabled: 1, last_auto_backup_at: null,
      last_auto_backup_status: null, last_auto_backup_error: null,
    });

    // Credentials must be in keyring, NOT in DB columns.
    const rows = await testDb.select<
      { access_key_id: string; secret_access_key: string }[]
    >("SELECT access_key_id, secret_access_key FROM settings_s3 WHERE id = 1");
    expect(rows[0].access_key_id).toBe("");
    expect(rows[0].secret_access_key).toBe("");

    expect(keyring.creds as unknown).toEqual({
      accessKeyId: "AKIA",
      secretAccessKey: "SECRET",
    });
  });

  test("getS3Settings merges keyring creds back in", async () => {
    keyring.creds = { accessKeyId: "AKIA-READ", secretAccessKey: "SECRET-READ" };
    await settings.saveS3Settings({
      enabled: 1, endpoint_url: "https://s3.example.com", region: "eu-central-1",
      bucket_name: "bucket", access_key_id: "AKIA-READ",
      secret_access_key: "SECRET-READ", path_prefix: "p",
      auto_backup_enabled: 0, last_auto_backup_at: null,
      last_auto_backup_status: null, last_auto_backup_error: null,
    });
    const got = await settings.getS3Settings();
    expect(got.access_key_id).toBe("AKIA-READ");
    expect(got.secret_access_key).toBe("SECRET-READ");
    expect(got.bucket_name).toBe("bucket");
  });

  test("returns S3 defaults when nothing saved and no keyring entry", async () => {
    keyring.creds = null;
    const got = await settings.getS3Settings();
    expect(got.enabled).toBe(0);
    expect(got.path_prefix).toBe("rechnungen");
  });
});
