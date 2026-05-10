import { invoke } from "@tauri-apps/api/core";
import {
  getS3Settings,
  saveS3Settings,
  type UpsertS3Settings,
} from "$lib/db/settings";
import { uploadFile } from "$lib/s3/client";
import { createLogger } from "$lib/logger";

const log = createLogger("auto-backup");
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let timerId: ReturnType<typeof setInterval> | null = null;

export function startAutoBackupScheduler(): void {
  if (timerId) return;
  checkAndBackup();
  timerId = setInterval(checkAndBackup, CHECK_INTERVAL_MS);
}

export function stopAutoBackupScheduler(): void {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

/**
 * Categorise a thrown value into a typed reason string. The string is
 * persisted to settings_s3.last_auto_backup_error so the dashboard can
 * surface a coarse-grained cause (auth/network/storage/unknown) without
 * leaking secrets or stack traces.
 */
export function classifyBackupError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const lower = raw.toLowerCase();
  if (
    lower.includes("403") ||
    lower.includes("401") ||
    lower.includes("accessdenied") ||
    lower.includes("invalidaccesskey") ||
    lower.includes("signaturedoesnotmatch") ||
    lower.includes("unauthor")
  ) {
    return "auth_error";
  }
  if (lower.includes("nosuchbucket") || lower.includes("404")) {
    return "bucket_not_found";
  }
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("network") ||
    lower.includes("dns") ||
    lower.includes("econnrefused") ||
    lower.includes("connection")
  ) {
    return "network_error";
  }
  if (lower.includes("backup_database") || lower.includes("sqlite")) {
    return "local_backup_error";
  }
  return "unknown_error";
}

async function checkAndBackup(): Promise<void> {
  try {
    const s3 = await getS3Settings();
    if (!s3.enabled || !s3.auto_backup_enabled) return;

    const last = s3.last_auto_backup_at
      ? new Date(s3.last_auto_backup_at).getTime()
      : 0;
    if (Date.now() - last < INTERVAL_MS) return;

    // performBackup persists its own failure status before re-throwing,
    // so we only need to log here.
    await performBackup(s3);
  } catch (e) {
    log.error("Auto-backup failed", e);
  }
}

async function recordBackupFailure(
  s3: UpsertS3Settings,
  e: unknown,
): Promise<void> {
  const reason = classifyBackupError(e);
  await saveS3Settings({
    ...s3,
    last_auto_backup_at: new Date().toISOString(),
    last_auto_backup_status: "failure",
    last_auto_backup_error: reason,
  });
}

export async function performBackup(s3?: UpsertS3Settings): Promise<void> {
  log.info("Starting backup");
  const settings = s3 ?? (await getS3Settings());
  try {
    const { bytes } = await invoke<{ file_name: string; bytes: number[] }>(
      "backup_database",
    );

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const backupFileName = `bookie-${timestamp}.db`;

    await uploadFile(
      settings,
      `${settings.path_prefix}/backups`,
      backupFileName,
      new Uint8Array(bytes),
      "application/octet-stream",
    );

    await saveS3Settings({
      ...settings,
      last_auto_backup_at: new Date().toISOString(),
      last_auto_backup_status: "success",
      last_auto_backup_error: null,
    });
  } catch (e) {
    // Bubble the error up so callers (scheduler + manual button) see it,
    // but persist the failure first so the dashboard banner shows something.
    await recordBackupFailure(settings, e);
    throw e;
  }
}
