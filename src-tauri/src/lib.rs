use std::{fs, path::PathBuf, time::Duration};

use aws_credential_types::Credentials;
use aws_sdk_s3::{
    config::Region, presigning::PresigningConfig, primitives::ByteStream, Client as S3Client,
};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

const DB_URL: &str = "sqlite:bookie.db";
const DB_FILE_NAME: &str = "bookie.db";
const KEYRING_SERVICE: &str = "com.ranelkarimov.bookie";
const KEYRING_USER: &str = "s3_credentials";

/// Typed error enum for all Bookie backend operations.
///
/// Serialises with `serde(tag = "kind")` so unit variants produce
/// `{"kind":"VariantName"}` and struct variants produce
/// `{"kind":"VariantName","field":"value"}`.
///
/// Note: the original spec defined `IoError(String)` and `Unknown(String)` as
/// tuple variants, but `serde(tag = "kind")` is incompatible with tuple variants.
/// They are therefore realised as struct variants with a single `message` field.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind")]
pub enum BookieError {
    S3CredsInvalid,
    S3Unreachable,
    S3BucketMissing,
    S3EndpointInvalid,
    BackupCorrupt,
    BackupSidecarMismatch,
    KeyringUnavailable,
    MigrationOutOfDate,
    InvoiceImmutable,
    IoError { message: String },
    Unknown { message: String },
}

impl std::fmt::Display for BookieError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BookieError::S3CredsInvalid => write!(f, "S3 credentials are invalid"),
            BookieError::S3Unreachable => write!(f, "S3 endpoint is unreachable"),
            BookieError::S3BucketMissing => write!(f, "S3 bucket does not exist"),
            BookieError::S3EndpointInvalid => write!(f, "S3 endpoint URL is invalid"),
            BookieError::BackupCorrupt => write!(f, "Backup file is corrupt"),
            BookieError::BackupSidecarMismatch => write!(f, "Backup sidecar checksum mismatch"),
            BookieError::KeyringUnavailable => write!(f, "OS keyring is unavailable"),
            BookieError::MigrationOutOfDate => write!(f, "Database migration is out of date"),
            BookieError::InvoiceImmutable => write!(f, "Invoice cannot be modified"),
            BookieError::IoError { message } => write!(f, "I/O error: {message}"),
            BookieError::Unknown { message } => write!(f, "Unknown error: {message}"),
        }
    }
}

impl From<std::io::Error> for BookieError {
    fn from(e: std::io::Error) -> Self {
        BookieError::IoError {
            message: e.to_string(),
        }
    }
}

#[cfg(test)]
mod bookie_error_tests {
    use super::BookieError;

    #[test]
    fn unit_variant_serialises_to_kind_only() {
        let s = serde_json::to_string(&BookieError::S3CredsInvalid).unwrap();
        assert_eq!(s, r#"{"kind":"S3CredsInvalid"}"#);
    }

    #[test]
    fn unit_variant_round_trips() {
        let original = BookieError::S3CredsInvalid;
        let json = serde_json::to_string(&original).unwrap();
        let parsed: BookieError = serde_json::from_str(&json).unwrap();
        // Verify discriminant round-trips by re-serialising
        assert_eq!(serde_json::to_string(&parsed).unwrap(), json);
    }

    #[test]
    fn struct_variant_round_trips() {
        let original = BookieError::IoError {
            message: "file not found".to_string(),
        };
        let json = serde_json::to_string(&original).unwrap();
        assert!(json.contains(r#""kind":"IoError""#));
        assert!(json.contains(r#""message":"file not found""#));
        let parsed: BookieError = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), json);
    }

    #[test]
    fn from_io_error_maps_to_io_error_variant() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        let bookie_err = BookieError::from(io_err);
        match bookie_err {
            BookieError::IoError { message } => assert!(message.contains("no such file")),
            other => panic!("expected IoError, got {other:?}"),
        }
    }
}

#[derive(Serialize)]
struct BackupPayload {
    file_name: String,
    bytes: Vec<u8>,
}

fn app_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial_accounting_schema_up",
            sql: concat!(
                include_str!("../migrations/0001/00_pragma.sql"),
                include_str!("../migrations/0001/01_companies.sql"),
                include_str!("../migrations/0001/02_customers.sql"),
                include_str!("../migrations/0001/03_projects.sql"),
                include_str!("../migrations/0001/04_invoices.sql"),
                include_str!("../migrations/0001/05_invoice_items.sql"),
                include_str!("../migrations/0001/06_time_entries.sql"),
                include_str!("../migrations/0001/07_payments.sql"),
                include_str!("../migrations/0001/08_invoice_status_history.sql"),
            ),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 1,
            description: "initial_accounting_schema_down",
            sql: concat!(
                include_str!("../migrations/0001_down/01_invoice_status_history.sql"),
                include_str!("../migrations/0001_down/02_payments.sql"),
                include_str!("../migrations/0001_down/03_time_entries.sql"),
                include_str!("../migrations/0001_down/04_invoice_items.sql"),
                include_str!("../migrations/0001_down/05_invoices.sql"),
                include_str!("../migrations/0001_down/06_projects.sql"),
                include_str!("../migrations/0001_down/07_customers.sql"),
                include_str!("../migrations/0001_down/08_companies.sql"),
            ),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 2,
            description: "settings_schema_up",
            sql: include_str!("../migrations/0002/01_settings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "settings_schema_down",
            sql: include_str!("../migrations/0002_down/01_settings.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 3,
            description: "customers_website_up",
            sql: include_str!("../migrations/0003/01_customers_website.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "customers_website_down",
            sql: include_str!("../migrations/0003_down/01_customers_website.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 4,
            description: "invoice_delivery_surcharge_up",
            sql: include_str!("../migrations/0004/01_invoice_delivery_surcharge.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "invoice_delivery_surcharge_down",
            sql: include_str!("../migrations/0004_down/01_invoice_delivery_surcharge.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 5,
            description: "org_bank_account_holder_up",
            sql: include_str!("../migrations/0005/01_org_bank_account_holder.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "org_bank_account_holder_down",
            sql: include_str!("../migrations/0005_down/01_org_bank_account_holder.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 6,
            description: "org_address_fields_up",
            sql: include_str!("../migrations/0006/01_org_address_fields.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "org_address_fields_down",
            sql: include_str!("../migrations/0006_down/01_org_address_fields.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 7,
            description: "customer_type_and_incoming_invoices_up",
            sql: include_str!("../migrations/0007/01_customer_type_and_incoming_invoices.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "customer_type_and_incoming_invoices_down",
            sql: include_str!("../migrations/0007_down/01_customer_type_and_incoming_invoices.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 8,
            description: "settings_s3_up",
            sql: include_str!("../migrations/0008/01_settings_s3.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "settings_s3_down",
            sql: include_str!("../migrations/0008_down/01_settings_s3.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 9,
            description: "incoming_invoices_s3_key_up",
            sql: include_str!("../migrations/0009/01_incoming_invoices_s3_key.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "incoming_invoices_s3_key_down",
            sql: include_str!("../migrations/0009_down/01_incoming_invoices_s3_key.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 10,
            description: "s3_auto_backup_up",
            sql: include_str!("../migrations/0010/01_s3_auto_backup.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "s3_auto_backup_down",
            sql: include_str!("../migrations/0010_down/01_s3_auto_backup.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 11,
            description: "payments_restrict_delete_up",
            sql: include_str!("../migrations/0011/01_payments_restrict_delete.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "payments_restrict_delete_down",
            sql: include_str!("../migrations/0011_down/01_payments_restrict_delete.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 12,
            description: "clear_s3_credentials_from_db_up",
            sql: include_str!("../migrations/0012/01_clear_s3_credentials.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "clear_s3_credentials_from_db_down",
            sql: include_str!("../migrations/0012_down/01_clear_s3_credentials.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 13,
            description: "invoices_s3_key_up",
            sql: include_str!("../migrations/0013/01_invoices_s3_key.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "invoices_s3_key_down",
            sql: include_str!("../migrations/0013_down/01_invoices_s3_key.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 14,
            description: "locale_and_legal_up",
            sql: include_str!("../migrations/0014/01_locale_and_legal.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "locale_and_legal_down",
            sql: include_str!("../migrations/0014_down/01_locale_and_legal.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 15,
            description: "money_cents_columns_up",
            sql: include_str!("../migrations/0015/01_money_cents_columns.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "money_cents_columns_down",
            sql: include_str!("../migrations/0015_down/01_money_cents_columns.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 16,
            description: "invoice_number_per_company_up",
            sql: include_str!("../migrations/0016/01_invoice_number_per_company.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "invoice_number_per_company_down",
            sql: include_str!("../migrations/0016_down/01_invoice_number_per_company.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 17,
            description: "invoice_audit_up",
            sql: include_str!("../migrations/0017/01_invoice_audit.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "invoice_audit_down",
            sql: include_str!("../migrations/0017_down/01_invoice_audit.sql"),
            kind: MigrationKind::Down,
        },
        Migration {
            version: 18,
            description: "auto_backup_status_up",
            sql: include_str!("../migrations/0018/01_auto_backup_status.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "auto_backup_status_down",
            sql: include_str!("../migrations/0018_down/01_auto_backup_status.sql"),
            kind: MigrationKind::Down,
        },
    ]
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app_data_dir: {err}"))?;
    let app_data_db = app_data_dir.join(DB_FILE_NAME);

    if app_data_db.exists() {
        return Ok(app_data_db);
    }

    let current_dir_db = PathBuf::from(DB_FILE_NAME);
    if current_dir_db.exists() {
        return Ok(current_dir_db);
    }

    fs::create_dir_all(&app_data_dir)
        .map_err(|err| format!("Failed to create app data directory: {err}"))?;

    Ok(app_data_db)
}

#[tauri::command]
fn backup_database(app: AppHandle) -> Result<BackupPayload, String> {
    info!("Creating database backup");
    let db_file = db_path(&app)?;
    let bytes = fs::read(&db_file).map_err(|err| {
        error!("Failed to read backup: {err}");
        format!("Failed to read backup: {err}")
    })?;

    info!("Backup created: {} bytes", bytes.len());
    Ok(BackupPayload {
        file_name: DB_FILE_NAME.to_string(),
        bytes,
    })
}

/// SQLite magic header bytes: "SQLite format 3\0"
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Validates that a byte slice looks like a usable SQLite backup before we
/// overwrite the live DB. Extracted from `restore_database` so it can be
/// unit-tested without a Tauri runtime.
fn validate_restore_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("The uploaded file is empty.".to_string());
    }
    if bytes.len() < 16 || &bytes[..16] != SQLITE_MAGIC {
        return Err("The file is not a valid SQLite database.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn restore_database(app: AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    info!("Database restore started ({} bytes)", bytes.len());
    validate_restore_bytes(&bytes)?;

    let db_file = db_path(&app)?;

    // Create automatic backup of current DB before overwriting
    let backup_file = db_file.with_extension("db.pre-restore-backup");
    if db_file.exists() {
        let _ = fs::copy(&db_file, &backup_file);
    }

    let wal_file = db_file.with_extension("db-wal");
    let shm_file = db_file.with_extension("db-shm");

    if wal_file.exists() {
        let _ = fs::remove_file(&wal_file);
    }

    if shm_file.exists() {
        let _ = fs::remove_file(&shm_file);
    }

    fs::write(db_file, bytes).map_err(|err| {
        error!("Failed to restore backup: {err}");
        format!("Failed to restore backup: {err}")
    })?;

    info!("Database restored successfully");
    Ok(())
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    info!("Writing file: {path}");
    fs::write(&path, &data).map_err(|e| format!("Failed to write file: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct S3Config {
    endpoint_url: String,
    region: String,
    bucket_name: String,
    access_key_id: String,
    secret_access_key: String,
}

impl S3Config {
    fn build_client(&self) -> S3Client {
        let credentials = Credentials::new(
            &self.access_key_id,
            &self.secret_access_key,
            None,
            None,
            "bookie",
        );

        let mut builder = aws_sdk_s3::Config::builder()
            .region(Region::new(self.region.clone()))
            .credentials_provider(credentials)
            .behavior_version_latest()
            .request_checksum_calculation(
                aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired,
            )
            .response_checksum_validation(
                aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired,
            );

        let ep = self.endpoint_url.trim_end_matches('/');
        if !ep.is_empty() {
            builder = builder.endpoint_url(ep).force_path_style(true);
        }

        S3Client::from_conf(builder.build())
    }
}

fn format_s3_error<E: std::fmt::Debug>(err: &aws_sdk_s3::error::SdkError<E>) -> String {
    match err {
        aws_sdk_s3::error::SdkError::ServiceError(ctx) => {
            let status = ctx.raw().status().as_u16();
            format!("status={status}, detail={:?}", ctx.err())
        }
        aws_sdk_s3::error::SdkError::DispatchFailure(err) => {
            format!("network/TLS error: {err:?}")
        }
        aws_sdk_s3::error::SdkError::TimeoutError(err) => {
            format!("timeout: {err:?}")
        }
        other => format!("{other:?}"),
    }
}

#[tauri::command]
async fn s3_test_connection(config: S3Config) -> Result<(), String> {
    info!("S3 connection test: bucket={}", config.bucket_name);
    let client = config.build_client();
    let test_key = ".bookie-connection-test";

    client
        .put_object()
        .bucket(&config.bucket_name)
        .key(test_key)
        .body(ByteStream::from_static(b"ok"))
        .content_length(2)
        .content_type("text/plain")
        .send()
        .await
        .map_err(|e| {
            let msg = format_s3_error(&e);
            error!("S3 connection test failed: {msg}");
            format!("S3 connection failed: {msg}")
        })?;

    let _ = client
        .delete_object()
        .bucket(&config.bucket_name)
        .key(test_key)
        .send()
        .await;

    info!("S3 connection test successful");
    Ok(())
}

/// Returns true if `data` looks like a SQLite database file based on its magic header.
///
/// SQLite files always start with the 16-byte string "SQLite format 3\0".
/// This is used to gate sidecar SHA-256 emission on backup uploads without
/// touching unrelated upload paths (e.g. invoice PDFs).
fn is_sqlite_backup(data: &[u8]) -> bool {
    data.len() >= SQLITE_MAGIC.len() && &data[..SQLITE_MAGIC.len()] == SQLITE_MAGIC
}

/// Lowercase hex SHA-256 digest of `data`.
fn sha256_hex(data: &[u8]) -> String {
    use std::fmt::Write;
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.as_slice() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Uploads a `<key>.sha256` sidecar containing the lowercase hex digest of the
/// just-uploaded backup. Failures here are logged but do NOT propagate: a flaky
/// sidecar must never roll back a successful main upload. The matching
/// download-side verification lives in REL-1.b/REL-1.c.
async fn upload_sha256_sidecar(client: &S3Client, bucket: &str, key: &str, digest_hex: &str) {
    let sidecar_key = format!("{key}.sha256");
    let body = digest_hex.as_bytes().to_vec();
    let body_len = body.len() as i64;

    match client
        .put_object()
        .bucket(bucket)
        .key(&sidecar_key)
        .body(ByteStream::from(body))
        .content_length(body_len)
        .content_type("text/plain")
        .send()
        .await
    {
        Ok(_) => info!("S3 sidecar upload successful: key={sidecar_key}"),
        Err(e) => {
            let msg = format_s3_error(&e);
            // Intentionally not propagating: see function docstring.
            warn!("S3 sidecar upload failed (non-fatal): key={sidecar_key}, {msg}");
        }
    }
}

#[tauri::command]
async fn s3_upload_file(
    config: S3Config,
    path_prefix: String,
    file_name: String,
    data: Vec<u8>,
    content_type: String,
) -> Result<String, String> {
    let prefix = path_prefix.trim_end_matches('/');
    let key = if prefix.is_empty() {
        file_name
    } else {
        format!("{prefix}/{file_name}")
    };

    info!("S3 upload: key={key}, size={}", data.len());
    let client = config.build_client();

    // Detect SQLite backups by magic header so we can attach a SHA-256 sidecar.
    // Other upload paths (invoice PDFs, connection-test blobs) are unaffected.
    let is_backup = is_sqlite_backup(&data);
    let digest_hex = if is_backup {
        Some(sha256_hex(&data))
    } else {
        None
    };

    let data_len = data.len() as i64;
    client
        .put_object()
        .bucket(&config.bucket_name)
        .key(&key)
        .body(ByteStream::from(data))
        .content_length(data_len)
        .content_type(&content_type)
        .send()
        .await
        .map_err(|e| {
            let msg = format_s3_error(&e);
            error!("S3 upload failed: key={key}, {msg}");
            format!("S3 upload failed: {msg}")
        })?;

    info!("S3 upload successful: key={key}");

    if let Some(digest) = digest_hex {
        upload_sha256_sidecar(&client, &config.bucket_name, &key, &digest).await;
    }

    Ok(key)
}

#[tauri::command]
async fn s3_download_file(config: S3Config, key: String) -> Result<Vec<u8>, String> {
    info!("S3 download: key={key}");
    let client = config.build_client();

    let resp = client
        .get_object()
        .bucket(&config.bucket_name)
        .key(&key)
        .send()
        .await
        .map_err(|e| {
            let msg = format_s3_error(&e);
            error!("S3 download failed: key={key}, {msg}");
            format!("S3 download failed: {msg}")
        })?;

    let bytes = resp
        .body
        .collect()
        .await
        .map_err(|e| format!("S3 download read error: {e}"))?
        .into_bytes();

    info!("S3 download successful: key={key}, size={}", bytes.len());
    Ok(bytes.to_vec())
}

#[tauri::command]
async fn s3_delete_file(config: S3Config, key: String) -> Result<(), String> {
    info!("S3 delete: key={key}");
    let client = config.build_client();

    client
        .delete_object()
        .bucket(&config.bucket_name)
        .key(&key)
        .send()
        .await
        .map_err(|e| {
            let msg = format_s3_error(&e);
            error!("S3 delete failed: key={key}, {msg}");
            format!("S3 delete failed: {msg}")
        })?;

    info!("S3 delete successful: key={key}");
    Ok(())
}

#[tauri::command]
async fn s3_presign_download_url(
    config: S3Config,
    key: String,
    expires_in_seconds: u64,
) -> Result<String, String> {
    info!("Presigned URL: key={key}, expires_in={expires_in_seconds}s");
    let client = config.build_client();

    let presigning_config = PresigningConfig::expires_in(Duration::from_secs(expires_in_seconds))
        .map_err(|e| format!("Presigning config failed: {e}"))?;

    let presigned = client
        .get_object()
        .bucket(&config.bucket_name)
        .key(&key)
        .presigned(presigning_config)
        .await
        .map_err(|e| format!("Presigned URL failed: {e}"))?;

    let url = presigned.uri().to_string();
    info!("Presigned URL created: key={key}");
    Ok(url)
}

// --- Keyring commands for S3 credential storage ---

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct S3Credentials {
    access_key_id: String,
    secret_access_key: String,
}

#[tauri::command]
fn store_s3_credentials(access_key_id: String, secret_access_key: String) -> Result<(), String> {
    if access_key_id.is_empty() || secret_access_key.is_empty() {
        return Err("Access Key ID and Secret Access Key must not be empty".into());
    }

    info!(
        "Storing S3 credentials in keyring (key_id_len={}, secret_len={})",
        access_key_id.len(),
        secret_access_key.len()
    );

    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {e}"))?;

    let creds = S3Credentials {
        access_key_id,
        secret_access_key,
    };
    let json = serde_json::to_string(&creds).map_err(|e| format!("Serialization failed: {e}"))?;

    entry
        .set_password(&json)
        .map_err(|e| format!("Keyring storage failed: {e}"))?;

    // Verify the credentials were actually persisted
    let readback = entry
        .get_password()
        .map_err(|e| format!("Keyring verification read failed: {e}"))?;
    if readback != json {
        return Err(
            "Keyring verification failed: stored credentials do not match. \
            The OS keyring service may not be working correctly."
                .into(),
        );
    }

    info!("S3 credentials stored and verified in keyring successfully");
    Ok(())
}

#[tauri::command]
fn get_s3_credentials() -> Result<S3Credentials, String> {
    info!("Reading S3 credentials from keyring");
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {e}"))?;

    match entry.get_password() {
        Ok(json) => {
            let creds: S3Credentials =
                serde_json::from_str(&json).map_err(|e| format!("Deserialization failed: {e}"))?;
            if creds.access_key_id.is_empty() || creds.secret_access_key.is_empty() {
                warn!("Keyring entry exists but credentials are empty");
            } else {
                info!(
                    "S3 credentials read successfully (key_id_len={}, secret_len={})",
                    creds.access_key_id.len(),
                    creds.secret_access_key.len()
                );
            }
            Ok(creds)
        }
        Err(keyring::Error::NoEntry) => {
            warn!("No S3 credentials found in keyring");
            Err("no_entry".into())
        }
        Err(e) => {
            warn!("Keyring read error: {e}");
            Err(format!("Keyring read error: {e}"))
        }
    }
}

#[tauri::command]
fn delete_s3_credentials() -> Result<(), String> {
    info!("Deleting S3 credentials from keyring");
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {e}"))?;

    match entry.delete_credential() {
        Ok(()) => {
            info!("S3 credentials deleted successfully");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keyring deletion failed: {e}")),
    }
}

#[cfg(test)]
mod pure_helper_tests {
    use super::{is_sqlite_backup, sha256_hex, validate_restore_bytes, SQLITE_MAGIC};

    #[test]
    fn sqlite_magic_constant_matches_spec() {
        assert_eq!(SQLITE_MAGIC, b"SQLite format 3\0");
        assert_eq!(SQLITE_MAGIC.len(), 16);
    }

    #[test]
    fn is_sqlite_backup_detects_magic_header() {
        let mut data = SQLITE_MAGIC.to_vec();
        data.extend_from_slice(b"...rest of db...");
        assert!(is_sqlite_backup(&data));
    }

    #[test]
    fn is_sqlite_backup_rejects_short_input() {
        assert!(!is_sqlite_backup(b""));
        assert!(!is_sqlite_backup(b"SQLite"));
        assert!(!is_sqlite_backup(&SQLITE_MAGIC[..15]));
    }

    #[test]
    fn is_sqlite_backup_rejects_wrong_magic() {
        let mut bad = vec![0u8; 32];
        bad[..3].copy_from_slice(b"PDF");
        assert!(!is_sqlite_backup(&bad));
    }

    #[test]
    fn sha256_hex_known_vector_empty_input() {
        // Standard SHA-256 of empty input.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_hex_known_vector_abc() {
        // FIPS-180-4 sample: SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_hex_is_lowercase_hex_with_fixed_length() {
        let digest = sha256_hex(b"any input");
        assert_eq!(digest.len(), 64);
        assert!(digest
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn validate_restore_bytes_rejects_empty() {
        let err = validate_restore_bytes(&[]).unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn validate_restore_bytes_rejects_non_sqlite() {
        let err = validate_restore_bytes(b"not a database, just text").unwrap_err();
        assert!(err.contains("SQLite"));
    }

    #[test]
    fn validate_restore_bytes_accepts_sqlite_header() {
        let mut data = SQLITE_MAGIC.to_vec();
        data.extend_from_slice(&[0u8; 100]);
        assert!(validate_restore_bytes(&data).is_ok());
    }

    #[test]
    fn validate_restore_bytes_rejects_too_short() {
        // Less than 16 bytes can never be a valid SQLite header.
        assert!(validate_restore_bytes(b"SQLite").is_err());
    }
}

#[cfg(test)]
mod s3_round_trip {
    //! Real S3 round-trip tests against a local MinIO instance.
    //!
    //! Gated by env var `BOOKIE_TEST_S3=1`. The pre-push script
    //! (`scripts/test-all.sh`) starts MinIO and sets this var. Without it
    //! these tests are skipped (silently OK) so a bare `cargo test` does not
    //! hang on a missing Docker container.
    use super::*;
    use aws_sdk_s3::types::{BucketLocationConstraint, CreateBucketConfiguration};

    const ENDPOINT: &str = "http://127.0.0.1:9100";
    const REGION: &str = "us-east-1";
    const ACCESS_KEY: &str = "minioadmin";
    const SECRET_KEY: &str = "minioadmin";
    const BUCKET: &str = "bookie-test";

    fn skip_if_disabled() -> bool {
        if std::env::var("BOOKIE_TEST_S3").ok().as_deref() != Some("1") {
            eprintln!("skipping: set BOOKIE_TEST_S3=1 with MinIO running to enable");
            return true;
        }
        false
    }

    fn cfg() -> S3Config {
        S3Config {
            endpoint_url: ENDPOINT.to_string(),
            region: REGION.to_string(),
            bucket_name: BUCKET.to_string(),
            access_key_id: ACCESS_KEY.to_string(),
            secret_access_key: SECRET_KEY.to_string(),
        }
    }

    async fn ensure_bucket() {
        let client = cfg().build_client();
        let location = CreateBucketConfiguration::builder()
            .location_constraint(BucketLocationConstraint::from(REGION))
            .build();
        let _ = client
            .create_bucket()
            .bucket(BUCKET)
            .create_bucket_configuration(location)
            .send()
            .await;
    }

    fn unique_key(prefix: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{prefix}-{nanos}")
    }

    #[tokio::test]
    async fn connection_test_succeeds_against_minio() {
        if skip_if_disabled() {
            return;
        }
        ensure_bucket().await;
        s3_test_connection(cfg())
            .await
            .expect("connection test should succeed");
    }

    #[tokio::test]
    async fn upload_download_delete_round_trip() {
        if skip_if_disabled() {
            return;
        }
        ensure_bucket().await;
        let key = unique_key("rtrip/file.bin");
        let data = b"non-sqlite payload".to_vec();

        let returned_key = s3_upload_file(
            cfg(),
            String::new(),
            key.clone(),
            data.clone(),
            "application/octet-stream".to_string(),
        )
        .await
        .expect("upload");
        assert_eq!(returned_key, key);

        let fetched = s3_download_file(cfg(), key.clone())
            .await
            .expect("download");
        assert_eq!(fetched, data);

        s3_delete_file(cfg(), key.clone()).await.expect("delete");

        let after_delete = s3_download_file(cfg(), key).await;
        assert!(after_delete.is_err(), "object should be gone after delete");
    }

    #[tokio::test]
    async fn sqlite_backup_uploads_with_sha256_sidecar() {
        if skip_if_disabled() {
            return;
        }
        ensure_bucket().await;
        let key = unique_key("backups/bookie.db");
        // Build a fake SQLite payload: the magic header + arbitrary bytes.
        let mut data = SQLITE_MAGIC.to_vec();
        data.extend_from_slice(b"the rest of the database");
        let expected_digest = sha256_hex(&data);

        s3_upload_file(
            cfg(),
            String::new(),
            key.clone(),
            data,
            "application/octet-stream".to_string(),
        )
        .await
        .expect("upload");

        let sidecar_key = format!("{key}.sha256");
        let sidecar_bytes = s3_download_file(cfg(), sidecar_key.clone())
            .await
            .expect("sidecar should exist for sqlite uploads");
        let sidecar = String::from_utf8(sidecar_bytes).expect("sidecar utf8");
        assert_eq!(sidecar, expected_digest);

        // Cleanup
        let _ = s3_delete_file(cfg(), key).await;
        let _ = s3_delete_file(cfg(), sidecar_key).await;
    }

    #[tokio::test]
    async fn non_sqlite_upload_does_not_emit_sidecar() {
        if skip_if_disabled() {
            return;
        }
        ensure_bucket().await;
        let key = unique_key("invoices/not-a-db.pdf");
        let data = b"%PDF-1.7 fake pdf content".to_vec();

        s3_upload_file(
            cfg(),
            String::new(),
            key.clone(),
            data,
            "application/pdf".to_string(),
        )
        .await
        .expect("upload");

        let sidecar_key = format!("{key}.sha256");
        let sidecar_result = s3_download_file(cfg(), sidecar_key).await;
        assert!(
            sidecar_result.is_err(),
            "non-sqlite uploads must not produce a .sha256 sidecar"
        );

        let _ = s3_delete_file(cfg(), key).await;
    }

    #[tokio::test]
    async fn presigned_url_returns_a_url_string() {
        if skip_if_disabled() {
            return;
        }
        ensure_bucket().await;
        let key = unique_key("presign/test.txt");
        s3_upload_file(
            cfg(),
            String::new(),
            key.clone(),
            b"hello".to_vec(),
            "text/plain".to_string(),
        )
        .await
        .unwrap();

        let url = s3_presign_download_url(cfg(), key.clone(), 60)
            .await
            .expect("presign");
        assert!(url.starts_with("http"), "got: {url}");
        assert!(url.contains(BUCKET));

        let _ = s3_delete_file(cfg(), key).await;
    }

    #[tokio::test]
    async fn path_prefix_is_joined_to_file_name() {
        if skip_if_disabled() {
            return;
        }
        ensure_bucket().await;
        let prefix = "rechnungen/2026";
        let file_name = unique_key("file.txt");
        let key = s3_upload_file(
            cfg(),
            prefix.to_string(),
            file_name.clone(),
            b"x".to_vec(),
            "text/plain".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(key, format!("{prefix}/{file_name}"));

        let _ = s3_delete_file(cfg(), key).await;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    info!("Bookie starting");

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(DB_URL, app_migrations())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            backup_database,
            restore_database,
            write_binary_file,
            s3_test_connection,
            s3_upload_file,
            s3_download_file,
            s3_delete_file,
            s3_presign_download_url,
            store_s3_credentials,
            get_s3_credentials,
            delete_s3_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
