// OPS-1.b: TypeScript mirror of the `BootStatus` shape returned by the
// Rust `boot_check` Tauri command (see OPS-1.a / `src-tauri/src/lib.rs`).
//
// Each probe slot is a `BootCheckResult<T>` which serialises to one of:
//   { status: "ok" }                           — probe succeeded, no info
//   { status: "ok", info: <T> }                — probe succeeded with payload
//   { status: "err", error: { kind: ... } }    — probe failed with typed BookieError
//   { status: "skipped", reason: "..." }       — probe was not applicable
//   { status: "delegated", to: "..." }         — probe is owned by another command
//
// The `delegated` and `skipped` variants are explicitly NOT failures: the
// blocking diagnostics view treats them as "pass" so the user is not gated
// on probes the backend deliberately did not run.
//
// Keep this file in lock-step with the Rust `BootCheckResult` and `BootStatus`
// definitions. Adding a probe slot requires extending `BootStatus` here AND
// the rendering map in `BootDiagnostics.svelte`.

import { invoke } from "@tauri-apps/api/core";
import type { S3Settings } from "$lib/db/types";

/** Minimal local mirror of the Rust `BookieError` discriminant string set,
 *  kept here so the diagnostics view can render without depending on the
 *  full TS DTO from OBS-2.c (PR #153). When that lands, the `kind` strings
 *  will line up structurally. */
export interface BootCheckError {
  kind: string;
  message?: string;
}

export type BootCheckResult<T = undefined> =
  | { status: "ok"; info?: T }
  | { status: "err"; error: BootCheckError }
  | { status: "skipped"; reason: string }
  | { status: "delegated"; to: string };

export interface BootStatus {
  app_data_dir: BootCheckResult<string>;
  keyring: BootCheckResult;
  s3: BootCheckResult;
  schema: BootCheckResult;
}

/** Slots whose failure must block the app (per OPS-1.b: "S3 failure is a
 *  warning, not blocking"). Schema is delegated to `schema_version_check`
 *  which the frontend invokes separately (OBS-3.a, PR #159); a `delegated`
 *  status is not a failure. */
export const BLOCKING_SLOTS = ["app_data_dir", "keyring"] as const;
export type BlockingSlot = (typeof BLOCKING_SLOTS)[number];

export const ALL_SLOTS = ["app_data_dir", "keyring", "s3", "schema"] as const;
export type Slot = (typeof ALL_SLOTS)[number];

/** True iff the slot's status counts as a failure. `skipped` and
 *  `delegated` are NOT failures. */
export function isFailure(result: BootCheckResult<unknown>): boolean {
  return result.status === "err";
}

/** True iff any blocking probe failed — the diagnostics view must be shown
 *  and nav must remain unreachable. */
export function hasBlockingFailure(status: BootStatus): boolean {
  return BLOCKING_SLOTS.some((slot) => isFailure(status[slot]));
}

/** True iff S3 failed. Rendered as a non-blocking warning above the nav. */
export function hasS3Warning(status: BootStatus): boolean {
  return isFailure(status.s3);
}

/** Tauri command bridge. The optional `s3_config` lets the backend skip the
 *  S3 probe when the user has not configured a bucket. */
export async function runBootCheck(
  s3Config?: {
    endpointUrl: string;
    region: string;
    bucketName: string;
    accessKeyId: string;
    secretAccessKey: string;
  } | null,
): Promise<BootStatus> {
  return invoke<BootStatus>("boot_check", {
    s3Config: s3Config ?? null,
  });
}

/** Build the optional `s3_config` argument for `boot_check` from a stored
 *  `S3Settings` row. Returns `null` when the user has not enabled S3 or has
 *  not provided credentials, so the backend skips the probe (slot becomes
 *  `{ status: "skipped" }`) instead of failing on empty creds. */
export function s3ConfigFromSettings(
  settings: Pick<
    S3Settings,
    | "enabled"
    | "endpoint_url"
    | "region"
    | "bucket_name"
    | "access_key_id"
    | "secret_access_key"
  > | null,
): {
  endpointUrl: string;
  region: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
} | null {
  if (!settings) return null;
  if (!settings.enabled) return null;
  if (!settings.access_key_id || !settings.secret_access_key) return null;
  if (!settings.bucket_name) return null;
  return {
    endpointUrl: settings.endpoint_url ?? "",
    region: settings.region ?? "",
    bucketName: settings.bucket_name,
    accessKeyId: settings.access_key_id,
    secretAccessKey: settings.secret_access_key,
  };
}
