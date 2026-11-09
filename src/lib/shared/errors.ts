/**
 * Frontend mirror of `BookieError` (defined in `src-tauri/src/lib.rs`).
 *
 * The Rust enum is serialized via `#[serde(tag = "kind")]`, which means every
 * variant — both unit and struct — is emitted as a JSON object with a `kind`
 * discriminant string. Struct variants additionally carry their fields
 * alongside `kind` (e.g. `{kind: "IoError", message: "..."}`).
 *
 * Tauri's command bridge resolves `Result<T, BookieError>::Err(e)` into a
 * rejected promise whose rejection value is the JSON-serialized `BookieError`.
 * In TypeScript that surfaces as either:
 *   - the parsed object itself (modern Tauri),
 *   - or a string holding the JSON (older bridges / event channels).
 * `parseBookieError()` accepts either shape.
 *
 * Keep this file in lock-step with the Rust enum: every variant added there
 * must appear in `BookieErrorKind`, `BookieError`, and `messageFor()`.
 */

import { t, tp } from "../i18n";

export type BookieErrorKind =
  | "S3CredsInvalid"
  | "S3Unreachable"
  | "S3BucketMissing"
  | "S3EndpointInvalid"
  | "BackupCorrupt"
  | "BackupSidecarMismatch"
  | "BackupSidecarMissing"
  | "KeyringUnavailable"
  | "MigrationOutOfDate"
  | "InvoiceImmutable"
  | "IoError"
  | "Unknown";

/** Discriminated union mirroring the Rust `BookieError` enum. */
export type BookieError =
  | { kind: "S3CredsInvalid" }
  | { kind: "S3Unreachable" }
  | { kind: "S3BucketMissing" }
  | { kind: "S3EndpointInvalid" }
  | { kind: "BackupCorrupt" }
  | { kind: "BackupSidecarMismatch" }
  | { kind: "BackupSidecarMissing" }
  | { kind: "KeyringUnavailable" }
  | { kind: "MigrationOutOfDate" }
  | { kind: "InvoiceImmutable" }
  | { kind: "IoError"; message: string }
  | { kind: "Unknown"; message: string };

const ALL_KINDS: ReadonlySet<BookieErrorKind> = new Set([
  "S3CredsInvalid",
  "S3Unreachable",
  "S3BucketMissing",
  "S3EndpointInvalid",
  "BackupCorrupt",
  "BackupSidecarMismatch",
  "BackupSidecarMissing",
  "KeyringUnavailable",
  "MigrationOutOfDate",
  "InvoiceImmutable",
  "IoError",
  "Unknown",
]);

const STRUCT_KINDS: ReadonlySet<BookieErrorKind> = new Set([
  "IoError",
  "Unknown",
]);

/**
 * Type guard for objects that look like a `BookieError`. Accepts only objects
 * whose `kind` string matches a known variant; struct-variant kinds must
 * additionally carry a `message: string` field.
 */
export function isBookieError(value: unknown): value is BookieError {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; message?: unknown };
  if (typeof candidate.kind !== "string") return false;
  if (!ALL_KINDS.has(candidate.kind as BookieErrorKind)) return false;
  if (STRUCT_KINDS.has(candidate.kind as BookieErrorKind)) {
    return typeof candidate.message === "string";
  }
  return true;
}

/**
 * Parse an arbitrary rejection value into a `BookieError`. Accepts:
 *   - a `BookieError` object (returned as-is after validation),
 *   - a JSON string holding a serialized `BookieError`,
 *   - any other shape (returned as `{kind: "Unknown", message: <stringified>}`).
 *
 * Never throws; the fallback ensures call sites can render *something*.
 */
export function parseBookieError(value: unknown): BookieError {
  if (isBookieError(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isBookieError(parsed)) return parsed;
    } catch {
      /* fall through to Unknown */
    }
    return { kind: "Unknown", message: value };
  }
  if (value instanceof Error) {
    return { kind: "Unknown", message: value.message };
  }
  try {
    return { kind: "Unknown", message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { kind: "Unknown", message: String(value) };
  }
}

/**
 * Return a user-facing message (current locale) for a `BookieError`.
 * The settings page (and any other error-rendering site) should call this
 * instead of stringifying the raw rejection.
 */
export function messageFor(err: BookieError): string {
  if (err.kind === "IoError" || err.kind === "Unknown") return tp(`errors.${err.kind}`, { message: err.message });
  return t(`errors.${err.kind}`);
}

/**
 * Convenience wrapper: parse + render in one call. Use this for the common
 * `catch (err) { feedback = messageForUnknown(err); }` pattern.
 */
export function messageForUnknown(value: unknown): string {
  return messageFor(parseBookieError(value));
}
