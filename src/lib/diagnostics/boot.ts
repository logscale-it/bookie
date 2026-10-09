// OPS-1.b: TypeScript mirror of the `BootStatus` shape returned by the
// Rust `boot_check` Tauri command (see OPS-1.a / `src-tauri/src/lib.rs`).
//
// Each probe slot is a `BootCheck` (Rust enum), serialised with
// `#[serde(tag = "kind")]` to one of:
//   { kind: "Ok" }                              — probe succeeded
//   { kind: "Skipped" }                         — probe was not applicable (e.g. S3 unconfigured)
//   { kind: "Failed", error: { kind: ... } }    — probe failed with a typed BookieError
//
// `Skipped` is explicitly NOT a failure: the blocking diagnostics view treats
// it as "pass" so the user is not gated on probes the backend deliberately did
// not run.
//
// Keep this file in lock-step with the Rust `BootCheck` / `BootStatus`
// definitions in `src-tauri/src/lib.rs`. The round-trip test
// `boot_check_serializes_with_kind_discriminator` pins the wire shape. Adding a
// probe slot requires extending `BootStatus` here AND the rendering map in
// `BootDiagnostics.svelte`.

import { invoke } from "@tauri-apps/api/core";

/** Minimal local mirror of the Rust `BookieError` discriminant string set.
 *  `BookieError` is serialised with `#[serde(tag = "kind")]`, so `kind` is the
 *  discriminant and other fields (`message`, `actual`, `expected`, ...) ride
 *  alongside it. */
export interface BootCheckError {
  kind: string;
  message?: string;
}

/** Mirror of the Rust `BootCheck` enum, serialised with
 *  `#[serde(tag = "kind")]`. */
export type BootCheckResult =
  | { kind: "Ok" }
  | { kind: "Skipped" }
  | { kind: "Failed"; error: BootCheckError };

/** Mirror of the Rust `BootStatus` struct: one `BootCheck` per probe slot.
 *  Field names are snake_case on the wire. */
export interface BootStatus {
  app_data: BootCheckResult;
  keyring: BootCheckResult;
  s3: BootCheckResult;
  schema: BootCheckResult;
}

/** Slots whose failure must block the app (per OPS-1.b: "S3 failure is a
 *  warning, not blocking"). The schema slot is handled by the dedicated
 *  schema-version recovery flow in the root layout (OBS-3.b), so it is not
 *  gated here. */
export const BLOCKING_SLOTS = ["app_data", "keyring"] as const;
export type BlockingSlot = (typeof BLOCKING_SLOTS)[number];

export const ALL_SLOTS = ["app_data", "keyring", "s3", "schema"] as const;
export type Slot = (typeof ALL_SLOTS)[number];

/** True iff the slot's probe failed. `Ok` and `Skipped` are NOT failures. */
export function isFailure(result: BootCheckResult): boolean {
  return result.kind === "Failed";
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

/** Tauri command bridge. Takes no arguments: the backend reads S3 settings
 *  (DB + keychain) itself and skips the probe when S3 is unconfigured. */
export async function runBootCheck(): Promise<BootStatus> {
  return invoke<BootStatus>("boot_check");
}
