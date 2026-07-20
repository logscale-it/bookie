import { invoke } from "@tauri-apps/api/core";
import type { UpsertS3Settings } from "$lib/db/settings";
import { createLogger } from "$lib/logger";

const log = createLogger("s3-client");

function buildConfig(settings: UpsertS3Settings) {
  if (!settings.access_key_id || !settings.secret_access_key) {
    throw new Error(
      "S3-Zugangsdaten fehlen. Bitte speichern Sie die S3-Einstellungen erneut.",
    );
  }
  return {
    endpointUrl: settings.endpoint_url,
    region: settings.region,
    bucketName: settings.bucket_name,
    accessKeyId: settings.access_key_id,
    secretAccessKey: settings.secret_access_key,
  };
}

export async function uploadFile(
  settings: UpsertS3Settings,
  pathPrefix: string,
  fileName: string,
  data: Uint8Array,
  contentType: string,
): Promise<string> {
  // Log only operational metadata — never the recipient name/address or
  // any other invoice details that flow through `data`. Storing PII in
  // the local log file is a DSGVO/GDPR liability the moment the log
  // ships anywhere (support bundle, S3 mirror, future cloud variant).
  const s3_key = pathPrefix ? `${pathPrefix}/${fileName}` : fileName;
  log.info("S3 op", { op: "upload", s3_key, byte_size: data.byteLength });
  return invoke<string>("s3_upload_file", {
    config: buildConfig(settings),
    pathPrefix,
    fileName,
    data: Array.from(data),
    contentType,
  });
}

/**
 * Back up the live SQLite DB to S3 entirely on the Rust side: the backend
 * streams the file from disk (64 KB window) and writes the SHA-256 sidecar.
 * No DB bytes ever cross the IPC boundary. Returns the object key.
 */
export async function backupDbToS3(
  settings: UpsertS3Settings,
  pathPrefix: string,
  fileName: string,
): Promise<string> {
  log.info("S3 op", { op: "backup_db", s3_key: `${pathPrefix}/${fileName}` });
  return invoke<string>("s3_backup_db", {
    config: buildConfig(settings),
    pathPrefix,
    fileName,
  });
}

export async function downloadFile(
  settings: UpsertS3Settings,
  key: string,
): Promise<Uint8Array> {
  log.info("S3 op", { op: "download", s3_key: key });
  const data = await invoke<number[]>("s3_download_file", {
    config: buildConfig(settings),
    key,
  });
  return new Uint8Array(data);
}

export async function deleteFile(
  settings: UpsertS3Settings,
  key: string,
): Promise<void> {
  log.info("S3 op", { op: "delete", s3_key: key });
  await invoke("s3_delete_file", {
    config: buildConfig(settings),
    key,
  });
}

export async function uploadInvoicePdf(
  settings: UpsertS3Settings,
  invoiceNumber: string,
  pdfBytes: Uint8Array,
): Promise<string> {
  return uploadFile(
    settings,
    settings.path_prefix,
    `${invoiceNumber}.pdf`,
    pdfBytes,
    "application/pdf",
  );
}

export async function presignDownloadUrl(
  settings: UpsertS3Settings,
  key: string,
  expiresInSeconds: number = 7 * 24 * 60 * 60,
): Promise<string> {
  return invoke<string>("s3_presign_download_url", {
    config: buildConfig(settings),
    key,
    expiresInSeconds,
  });
}

export async function testConnection(
  settings: UpsertS3Settings,
): Promise<void> {
  await invoke("s3_test_connection", {
    config: buildConfig(settings),
  });
}
