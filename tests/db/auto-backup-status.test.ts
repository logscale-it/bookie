import { test, expect, describe, beforeEach, mock } from "bun:test";

// Mock the keyring boundary BEFORE importing modules that touch it.
const keyring: {
  creds: { accessKeyId: string; secretAccessKey: string } | null;
} = { creds: null };

// Track the last `backup_database` invocation outcome the test wants.
const backend: { backupShouldFail: Error | null } = { backupShouldFail: null };

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    if (cmd === "store_s3_credentials") {
      const a = args as { accessKeyId: string; secretAccessKey: string };
      keyring.creds = {
        accessKeyId: a.accessKeyId,
        secretAccessKey: a.secretAccessKey,
      };
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
    if (cmd === "backup_database") {
      if (backend.backupShouldFail) throw backend.backupShouldFail;
      return { file_name: "bookie.db", bytes: [1, 2, 3, 4] };
    }
    throw new Error(`unmocked invoke: ${cmd}`);
  },
}));

// Stub the S3 client so the test never touches the network. Each test arms
// uploadShouldFail to flip the outcome.
const s3client: { uploadShouldFail: Error | null; uploads: number } = {
  uploadShouldFail: null,
  uploads: 0,
};
mock.module("../../src/lib/s3/client", () => ({
  uploadFile: async () => {
    s3client.uploads += 1;
    if (s3client.uploadShouldFail) throw s3client.uploadShouldFail;
  },
}));

import "./setup";
import * as settings from "../../src/lib/db/settings";
import { performBackup } from "../../src/lib/s3/auto-backup";

const BASE_S3 = {
  enabled: 1,
  endpoint_url: "https://s3.example.com",
  region: "eu-central-1",
  bucket_name: "bookie-test",
  access_key_id: "AKIA",
  secret_access_key: "SECRET",
  path_prefix: "rechnungen",
  auto_backup_enabled: 1,
  last_auto_backup_at: null as string | null,
  last_auto_backup_status: null as "success" | "failure" | null,
  last_auto_backup_error: null as string | null,
};

beforeEach(async () => {
  keyring.creds = { accessKeyId: "AKIA", secretAccessKey: "SECRET" };
  backend.backupShouldFail = null;
  s3client.uploadShouldFail = null;
  s3client.uploads = 0;
  await settings.saveS3Settings({ ...BASE_S3 });
});

describe("performBackup status persistence — REL-3.b", () => {
  test("success path writes status='success', clears error, advances last_auto_backup_at", async () => {
    const before = (await settings.getS3Settings()).last_auto_backup_at;
    await performBackup();
    const after = await settings.getS3Settings();
    expect(after.last_auto_backup_status).toBe("success");
    expect(after.last_auto_backup_error).toBeNull();
    expect(after.last_auto_backup_at).not.toBeNull();
    expect(after.last_auto_backup_at).not.toBe(before);
    expect(s3client.uploads).toBe(1);
  });

  test("upload failure persists status='failure' with classified reason and re-throws", async () => {
    s3client.uploadShouldFail = new Error("403 AccessDenied");
    let threw: unknown = null;
    try {
      await performBackup();
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    const after = await settings.getS3Settings();
    expect(after.last_auto_backup_status).toBe("failure");
    expect(after.last_auto_backup_error).toBe("auth_error");
    expect(after.last_auto_backup_at).not.toBeNull();
  });

  test("backup_database failure is recorded with local_backup_error reason", async () => {
    backend.backupShouldFail = new Error("sqlite disk I/O");
    let threw: unknown = null;
    try {
      await performBackup();
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    const after = await settings.getS3Settings();
    expect(after.last_auto_backup_status).toBe("failure");
    expect(after.last_auto_backup_error).toBe("local_backup_error");
    // No upload should have happened — the local backup itself failed.
    expect(s3client.uploads).toBe(0);
  });

  test("recovery: failure followed by success clears the error", async () => {
    s3client.uploadShouldFail = new Error("network timeout");
    try {
      await performBackup();
    } catch {
      /* expected */
    }
    let after = await settings.getS3Settings();
    expect(after.last_auto_backup_status).toBe("failure");
    expect(after.last_auto_backup_error).toBe("network_error");

    s3client.uploadShouldFail = null;
    await performBackup();
    after = await settings.getS3Settings();
    expect(after.last_auto_backup_status).toBe("success");
    expect(after.last_auto_backup_error).toBeNull();
  });
});
