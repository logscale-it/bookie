type Level = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: Level;
  module: string;
  message: string;
  data?: unknown;
  timestamp: string;
}

function createLogger(module: string) {
  const log = (level: Level, message: string, data?: unknown) => {
    // Redact PII from `data` before it touches any sink (console today,
    // log file / support bundle / S3 mirror tomorrow). `redact()` is a
    // pure deep copy and is idempotent on already-redacted values, so
    // wrapping at this single choke point is sufficient — call sites do
    // not need to invoke `redact()` themselves.
    //
    // Error instances are passed through untouched: their fields are
    // non-enumerable, `redact()` would deep-copy them to `{}` and we'd
    // lose the stack trace. Errors are diagnostic data, not PII.
    const safeData =
      data === undefined || data instanceof Error ? data : redact(data);
    const entry: LogEntry = {
      level,
      module,
      message,
      timestamp: new Date().toISOString(),
      ...(safeData !== undefined && { data: safeData }),
    };
    const method = level === "debug" ? "log" : level;
    console[method](
      `[${level.toUpperCase()}] [${module}]`,
      message,
      safeData !== undefined ? safeData : "",
    );
  };

  return {
    debug: (message: string, data?: unknown) => log("debug", message, data),
    info: (message: string, data?: unknown) => log("info", message, data),
    warn: (message: string, data?: unknown) => log("warn", message, data),
    error: (message: string, data?: unknown) => log("error", message, data),
  };
}

/**
 * Regex patterns matching object keys whose values are considered PII and
 * must be redacted before being written to logs.
 *
 * Matching is performed against a normalized form of the key (lowercased,
 * with `_`/`-`/camelCase boundaries collapsed), so `recipientName`,
 * `recipient_name` and `recipient-name` all match the `name` pattern.
 */
const PII_KEY_PATTERNS: readonly RegExp[] = [
  /name/,
  /email/,
  /iban/,
  /bic/,
  /address/,
  /postal/,
  /city/,
  /tax_?id/,
  /vat_?id/,
  /phone/,
];

/** Normalize a key for PII matching: lowercase, separators stripped. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function isPiiKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return PII_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Deterministic 32-bit FNV-1a hash, returned as 8 lowercase hex characters.
 * Non-cryptographic — used purely to obfuscate PII while preserving the
 * ability to correlate identical values across log lines.
 */
function fnv1a8(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiplication via Math.imul
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function redactPlaceholder(value: unknown): string {
  const serialized =
    typeof value === "string"
      ? value
      : (JSON.stringify(value) ?? String(value));
  return `[REDACTED:${fnv1a8(serialized)}]`;
}

/**
 * Walks an arbitrary value and returns a deep copy with PII leaf values
 * replaced by a deterministic `[REDACTED:<8-hex>]` placeholder. A leaf is
 * treated as PII when its containing object key matches `PII_KEY_PATTERNS`;
 * matching is purely key-based (value shape is not inspected).
 *
 * Pure: does not mutate `value`.
 */
function redact<T>(value: T): T {
  return redactInternal(value) as T;
}

function redactInternal(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    // Arrays inherit the parent key — every element of `emails: [...]` is PII.
    return value.map((item) => redactInternal(item, parentKey));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = redactInternal(child, key);
    }
    return out;
  }
  // Primitive (or null/undefined): redact iff containing key is PII.
  if (
    parentKey !== undefined &&
    isPiiKey(parentKey) &&
    value !== undefined &&
    value !== null
  ) {
    return redactPlaceholder(value);
  }
  return value;
}

export { createLogger, redact, PII_KEY_PATTERNS };
export type { LogEntry, Level };
