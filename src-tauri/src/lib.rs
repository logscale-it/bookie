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
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder as RollingBuilder, Rotation};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

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
    BackupSidecarMissing,
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
            BookieError::BackupSidecarMissing => write!(f, "Backup sidecar (.sha256) not found"),
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
        Migration {
            version: 19,
            description: "invoice_audit_triggers_up",
            sql: include_str!("../migrations/0019/01_invoice_audit_triggers.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "invoice_audit_triggers_down",
            sql: include_str!("../migrations/0019_down/01_invoice_audit_triggers.sql"),
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

// --- Retry helper for transient S3 failures (REL-2.a) ---
//
// `with_retry` runs an async operation up to `policy.max_attempts` times,
// retrying only when the returned error is classified as transient by the
// `IsRetryable` trait. Between attempts it sleeps for an exponentially
// increasing base delay (250ms, 500ms, 1000ms, ...) multiplied by a uniform
// random factor in [0.5, 1.5] (full jitter).
//
// REL-2.b will wrap the existing S3 commands in this helper. This module
// only provides the helper and its policy / classification primitives.

/// Configuration for `with_retry`.
#[allow(dead_code)] // wired into S3 commands by REL-2.b
#[derive(Debug, Clone, Copy)]
pub(crate) struct RetryPolicy {
    /// Total number of attempts (including the first). Must be >= 1.
    pub max_attempts: u32,
    /// Base delay for the first backoff sleep in milliseconds. The sleep
    /// before attempt N is `base_delay_ms * 2^(N-2)` jittered to [0.5x, 1.5x].
    pub base_delay_ms: u64,
}

#[allow(dead_code)] // wired into S3 commands by REL-2.b
impl RetryPolicy {
    /// Default policy used by S3 commands: 3 attempts with 250ms / 500ms / 1s
    /// exponential backoff plus full jitter.
    pub(crate) fn s3_default() -> Self {
        Self {
            max_attempts: 3,
            base_delay_ms: 250,
        }
    }
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::s3_default()
    }
}

/// Implemented by error types that can distinguish transient failures from
/// permanent ones. `with_retry` only retries when this returns `true`.
#[allow(dead_code)] // wired into S3 commands by REL-2.b
pub(crate) trait IsRetryable {
    fn is_retryable(&self) -> bool;
}

impl<E> IsRetryable for aws_sdk_s3::error::SdkError<E> {
    fn is_retryable(&self) -> bool {
        use aws_sdk_s3::error::SdkError;
        match self {
            // Network-level dispatch errors: DNS resolution, connection
            // reset, TLS hiccups. All considered transient.
            SdkError::DispatchFailure(_) => true,
            // Smithy timeout (request timed out before a response).
            SdkError::TimeoutError(_) => true,
            // Could not parse / read the response stream.
            SdkError::ResponseError(_) => true,
            // Construction failures are bugs in the request, not transient.
            SdkError::ConstructionFailure(_) => false,
            // Service responded with a status code. Retry 5xx and 429,
            // fail fast on every other 4xx (NoSuchBucket, AccessDenied, ...).
            SdkError::ServiceError(ctx) => {
                let status = ctx.raw().status().as_u16();
                status >= 500 || status == 429
            }
            // SdkError is `#[non_exhaustive]`; be conservative on unknown
            // variants and do not retry.
            _ => false,
        }
    }
}

/// Run `op` with bounded exponential backoff. The closure is invoked once per
/// attempt so the caller can build a fresh request each time (AWS SDK request
/// builders are single-use).
#[allow(dead_code)] // wired into S3 commands by REL-2.b
pub(crate) async fn with_retry<F, Fut, T, E>(mut op: F, policy: RetryPolicy) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: IsRetryable,
{
    let max_attempts = policy.max_attempts.max(1);

    let mut attempt: u32 = 1;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            Err(err) => {
                if !err.is_retryable() || attempt >= max_attempts {
                    return Err(err);
                }
                // exponent = attempt - 1 (0, 1, 2, ...) -> 250ms, 500ms, 1s
                let exp = attempt - 1;
                let base = policy.base_delay_ms.saturating_mul(1u64 << exp.min(20));
                let jittered = jitter_full(base);
                tokio::time::sleep(Duration::from_millis(jittered)).await;
                attempt += 1;
            }
        }
    }
}

/// Multiply `base_ms` by a uniform random factor in [0.5, 1.5] using a small
/// inline PRNG seeded from the system clock. Avoids pulling in `rand` for a
/// single use site.
#[allow(dead_code)] // wired into S3 commands by REL-2.b
fn jitter_full(base_ms: u64) -> u64 {
    if base_ms == 0 {
        return 0;
    }
    // Half of base, plus a uniform sample in [0, base_ms].
    let half = base_ms / 2;
    // full span = base_ms; result in [half, half + base_ms] = [0.5x, 1.5x]
    let modulus = base_ms.saturating_add(1);
    let r = next_rand_u64();
    let offset = r % modulus;
    half.saturating_add(offset)
}

/// Tiny xorshift64* PRNG. Thread-local, seeded once from the wall clock. Not
/// cryptographically secure -- only used for jitter on retry delays.
#[allow(dead_code)] // wired into S3 commands by REL-2.b
fn next_rand_u64() -> u64 {
    use std::cell::Cell;
    use std::time::{SystemTime, UNIX_EPOCH};

    thread_local! {
        static STATE: Cell<u64> = const { Cell::new(0) };
    }

    STATE.with(|cell| {
        let mut s = cell.get();
        if s == 0 {
            // Lazy seed from the wall clock; XORed with a fixed odd
            // constant so a near-zero clock cannot leave the PRNG zeroed.
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x9E37_79B9_7F4A_7C15);
            s = nanos ^ 0xA076_1D64_78BD_642F_u64;
            if s == 0 {
                s = 0xA076_1D64_78BD_642F_u64;
            }
        }
        // xorshift64*
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        cell.set(s);
        s.wrapping_mul(0x2545_F491_4F6C_DD1D)
    })
}

/// Validates S3 endpoint URL scheme. Requires `https://` except for localhost.
///
/// # Rules
/// - `https://` is always allowed
/// - `http://` is allowed only for localhost, 127.0.0.1, or ::1
/// - Any other scheme or malformed URL is rejected
fn validate_endpoint(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url)
        .map_err(|_| format!("Invalid URL: '{}' does not parse as a valid URL", url))?;

    match parsed.scheme() {
        "https" => Ok(()),
        "http" => {
            let host = parsed
                .host_str()
                .ok_or_else(|| format!("URL '{}' has no host", url))?
                .to_lowercase();

            match host.as_str() {
                "localhost" | "127.0.0.1" | "::1" => Ok(()),
                _ => Err(format!(
                    "http:// is only allowed for localhost, 127.0.0.1, or ::1; got '{}'",
                    host
                )),
            }
        }
        scheme => Err(format!(
            "Invalid URL scheme '{}'; must be 'http' or 'https'",
            scheme
        )),
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

/// Restore the live SQLite database from an S3 backup with SHA-256 sidecar
/// verification.
///
/// Flow (REL-1.b):
///   1. Download the backup at `key` from S3 into `<dbpath>.restore.tmp`
///      (NOT in place — never touch the live file until verification passes).
///   2. Fetch the sidecar at `<key>.sha256`. If missing and
///      `allow_missing_sidecar == false`, return `BackupSidecarMissing` so the
///      frontend can prompt the user to confirm an unsafe restore.
///   3. If a sidecar is present, compute SHA-256 of the .tmp file and compare
///      against the sidecar contents. Abort with `BackupSidecarMismatch` on
///      any disagreement; the .tmp file is removed before returning.
///   4. Validate the SQLite magic header on the .tmp file.
///   5. Swap the .tmp file into place over the live DB.
///
/// Step 5 is intentionally still an in-place overwrite (matching the existing
/// `restore_database` semantics) and currently does NOT verify that the
/// sql plugin's connections are closed nor fsync before reopen. Both of those
/// — plus a true atomic rename — are REL-1.c's scope (issue #44). This ticket
/// (REL-1.b) is only the download-to-tmp + SHA verification step.
#[tauri::command]
async fn restore_db_backup(
    app: AppHandle,
    config: S3Config,
    key: String,
    allow_missing_sidecar: bool,
) -> Result<(), BookieError> {
    info!("Restore from S3: key={key}, allow_missing_sidecar={allow_missing_sidecar}");

    let db_file = db_path(&app).map_err(|message| BookieError::IoError { message })?;
    let tmp_file = db_file.with_extension("db.restore.tmp");

    // Best-effort cleanup of any leftover .tmp from a previous failed run.
    if tmp_file.exists() {
        let _ = fs::remove_file(&tmp_file);
    }

    let client = config.build_client();

    // 1. Download the backup into the .tmp file.
    let backup_resp = client
        .get_object()
        .bucket(&config.bucket_name)
        .key(&key)
        .send()
        .await
        .map_err(|e| {
            let msg = format_s3_error(&e);
            error!("S3 download failed: key={key}, {msg}");
            BookieError::S3Unreachable
        })?;

    let backup_bytes = backup_resp
        .body
        .collect()
        .await
        .map_err(|e| BookieError::IoError {
            message: format!("S3 download read error: {e}"),
        })?
        .into_bytes();

    if backup_bytes.is_empty() {
        return Err(BookieError::BackupCorrupt);
    }

    fs::write(&tmp_file, backup_bytes.as_ref()).map_err(|err| {
        error!("Failed to write restore tmp: {err}");
        BookieError::IoError {
            message: format!("Failed to write restore tmp: {err}"),
        }
    })?;

    // Helper: clean up the .tmp file on any abort path.
    let cleanup_tmp = |path: &PathBuf| {
        if path.exists() {
            if let Err(e) = fs::remove_file(path) {
                warn!("Failed to clean up restore tmp file: {e}");
            }
        }
    };

    // 2. Fetch the sidecar.
    let sidecar_key = format!("{key}.sha256");
    let sidecar_resp = client
        .get_object()
        .bucket(&config.bucket_name)
        .key(&sidecar_key)
        .send()
        .await;

    let expected_digest: Option<String> = match sidecar_resp {
        Ok(resp) => {
            let body = resp.body.collect().await.map_err(|e| {
                cleanup_tmp(&tmp_file);
                BookieError::IoError {
                    message: format!("S3 sidecar read error: {e}"),
                }
            })?;
            let bytes = body.into_bytes();
            let text = std::str::from_utf8(bytes.as_ref())
                .map_err(|_| {
                    cleanup_tmp(&tmp_file);
                    BookieError::BackupSidecarMismatch
                })?
                .trim()
                .to_string();
            // A valid sidecar is exactly 64 lowercase hex chars (per REL-1.a:
            // sha256_hex always emits lowercase). Reject anything else.
            let valid_shape = text.len() == 64
                && text
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
            if !valid_shape {
                cleanup_tmp(&tmp_file);
                error!("Sidecar contents are not a valid lowercase SHA-256 hex digest");
                return Err(BookieError::BackupSidecarMismatch);
            }
            Some(text)
        }
        Err(e) => {
            // Distinguish "key not found" (HTTP 404 / NoSuchKey) from other S3
            // errors so we can honour `allow_missing_sidecar` only for the
            // former. We match on the 404 status alone for robustness across
            // SDK error-variant shapes.
            let is_missing = matches!(
                &e,
                aws_sdk_s3::error::SdkError::ServiceError(ctx)
                    if ctx.raw().status().as_u16() == 404
            );
            if is_missing {
                if !allow_missing_sidecar {
                    cleanup_tmp(&tmp_file);
                    warn!("Sidecar missing for key={key}; aborting (no unsafe override)");
                    return Err(BookieError::BackupSidecarMissing);
                }
                warn!("Sidecar missing for key={key}; proceeding under user-confirmed unsafe path");
                None
            } else {
                cleanup_tmp(&tmp_file);
                let msg = format_s3_error(&e);
                error!("S3 sidecar fetch failed: key={sidecar_key}, {msg}");
                return Err(BookieError::S3Unreachable);
            }
        }
    };

    // 3. Verify the .tmp file's SHA-256 matches the sidecar.
    if let Some(expected) = expected_digest.as_deref() {
        let tmp_bytes = fs::read(&tmp_file).map_err(|err| {
            cleanup_tmp(&tmp_file);
            BookieError::IoError {
                message: format!("Failed to re-read restore tmp: {err}"),
            }
        })?;
        let actual = sha256_hex(&tmp_bytes);
        if actual != expected {
            cleanup_tmp(&tmp_file);
            error!("Sidecar SHA-256 mismatch: expected={expected}, actual={actual}, key={key}");
            return Err(BookieError::BackupSidecarMismatch);
        }
        info!("Sidecar SHA-256 verified for key={key}");
    }

    // 4. Sanity-check the SQLite magic header on the verified .tmp file.
    if !is_sqlite_backup(backup_bytes.as_ref()) {
        cleanup_tmp(&tmp_file);
        error!("Restored bytes failed SQLite magic-header check: key={key}");
        return Err(BookieError::BackupCorrupt);
    }

    // 5. Swap the .tmp file into place. NOTE: REL-1.c (issue #44) will replace
    // this with a true atomic rename plus connection-quiesce + fsync. For now
    // we keep the existing in-place overwrite semantics so this PR's diff stays
    // focused on the SHA-verification half of REL-1.
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

    fs::write(&db_file, backup_bytes.as_ref()).map_err(|err| {
        cleanup_tmp(&tmp_file);
        error!("Failed to overwrite live DB during restore: {err}");
        BookieError::IoError {
            message: format!("Failed to overwrite live DB: {err}"),
        }
    })?;

    // Restore-tmp is no longer needed once the live DB is written.
    cleanup_tmp(&tmp_file);

    info!("Database restored successfully from S3: key={key}");
    Ok(())
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

/// Initialise the global `tracing` subscriber with two layers:
///
/// 1. A human-readable fmt layer that writes to stdout (so `bun run tauri dev`
///    keeps showing logs in the terminal).
/// 2. A JSON-line layer that writes to a daily-rotating file in `app_log_dir`,
///    retaining the last 14 files. The file layout produced by
///    `RollingFileAppender::builder()` is
///    `<app_log_dir>/bookie.<YYYY-MM-DD>.log`.
///
/// `RUST_LOG` controls verbosity; absent, we default to `info,bookie=debug`.
///
/// Existing `log::info!`/`log::warn!`/`log::error!` calls are bridged into
/// `tracing` via the `tracing-log` feature of `tracing-subscriber` (enabled
/// transitively by the explicit `tracing-log` dependency and by
/// `LogTracer::init()`), so adding this subscriber does not require touching
/// every call site.
///
/// Returns the `WorkerGuard` of the non-blocking file writer; the caller MUST
/// keep it alive for the lifetime of the app (we stash it in Tauri-managed
/// state) — dropping it flushes and stops the background writer thread.
fn init_tracing(log_dir: &std::path::Path) -> Result<WorkerGuard, Box<dyn std::error::Error>> {
    fs::create_dir_all(log_dir)?;

    let file_appender = RollingBuilder::new()
        .filename_prefix("bookie")
        .filename_suffix("log")
        .rotation(Rotation::DAILY)
        .max_log_files(14)
        .build(log_dir)?;

    let (nb_writer, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = || {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,bookie=debug"))
    };

    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_writer(std::io::stdout)
        .with_filter(env_filter());

    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(false)
        .with_writer(nb_writer)
        .with_filter(env_filter());

    // Bridge classic `log` macros into `tracing` so existing call sites in this
    // crate (and dependencies that emit through `log`) flow into both layers.
    // Best-effort: if another component already installed a `log` logger we
    // keep going rather than panicking on startup.
    let _ = tracing_log::LogTracer::init();

    tracing_subscriber::registry()
        .with(stdout_layer)
        .with(file_layer)
        .try_init()?;

    Ok(guard)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(DB_URL, app_migrations())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // OBS-1.a: install the tracing subscriber as early as possible so
            // that subsequent setup work and command handlers land in the file
            // sink. The panic hook (OBS-1.b) and the frontend log bridge
            // (OBS-1.c) layer on top of this; they are intentionally out of
            // scope here.
            match app
                .path()
                .app_log_dir()
                .map_err(|e| e.to_string())
                .and_then(|dir| {
                    init_tracing(&dir)
                        .map(|guard| (dir, guard))
                        .map_err(|e| e.to_string())
                }) {
                Ok((log_dir, guard)) => {
                    // Hold the WorkerGuard for the lifetime of the app via
                    // Tauri-managed state. Dropping it flushes the non-blocking
                    // writer; we want that to happen at process shutdown only.
                    app.manage(guard);
                    info!("Bookie starting (log_dir={})", log_dir.display());
                }
                Err(err) => {
                    // Logger setup failed — fall back to env_logger so the app
                    // is still observable on stdout. We surface the failure on
                    // stderr because no logger is installed yet at this point.
                    eprintln!("tracing init failed, falling back to env_logger: {err}");
                    let _ = env_logger::try_init();
                    info!("Bookie starting (file logging disabled)");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backup_database,
            restore_database,
            write_binary_file,
            s3_test_connection,
            s3_upload_file,
            s3_download_file,
            restore_db_backup,
            s3_delete_file,
            s3_presign_download_url,
            store_s3_credentials,
            get_s3_credentials,
            delete_s3_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod retry_tests {
    use super::{with_retry, IsRetryable, RetryPolicy};
    use std::cell::Cell;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TestErr {
        Transient,
        Permanent,
    }

    impl IsRetryable for TestErr {
        fn is_retryable(&self) -> bool {
            matches!(self, TestErr::Transient)
        }
    }

    fn fast_policy(max_attempts: u32) -> RetryPolicy {
        // 1ms base keeps the tests well under 10ms total.
        RetryPolicy {
            max_attempts,
            base_delay_ms: 1,
        }
    }

    #[tokio::test]
    async fn first_attempt_succeeds() {
        let calls = Cell::new(0u32);
        let res = with_retry(
            || {
                calls.set(calls.get() + 1);
                async { Ok::<&'static str, TestErr>("ok") }
            },
            fast_policy(3),
        )
        .await;
        assert_eq!(res, Ok("ok"));
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn transient_then_success() {
        let calls = Cell::new(0u32);
        let res = with_retry(
            || {
                let n = calls.get() + 1;
                calls.set(n);
                async move {
                    if n == 1 {
                        Err::<&'static str, TestErr>(TestErr::Transient)
                    } else {
                        Ok("ok")
                    }
                }
            },
            fast_policy(3),
        )
        .await;
        assert_eq!(res, Ok("ok"));
        assert_eq!(calls.get(), 2);
    }

    #[tokio::test]
    async fn permanent_fails_fast() {
        let calls = Cell::new(0u32);
        let res = with_retry(
            || {
                calls.set(calls.get() + 1);
                async { Err::<(), TestErr>(TestErr::Permanent) }
            },
            fast_policy(3),
        )
        .await;
        assert_eq!(res, Err(TestErr::Permanent));
        // Permanent error must not retry: exactly one attempt.
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn exhausts_attempts_on_persistent_transient() {
        let calls = Cell::new(0u32);
        let res = with_retry(
            || {
                calls.set(calls.get() + 1);
                async { Err::<(), TestErr>(TestErr::Transient) }
            },
            fast_policy(3),
        )
        .await;
        assert_eq!(res, Err(TestErr::Transient));
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn jitter_stays_in_full_jitter_band() {
        // [0.5x, 1.5x] of 1000 ms = [500, 1500]. Sample many times and
        // assert the bounds always hold.
        for _ in 0..1000 {
            let v = super::jitter_full(1000);
            assert!((500..=1500).contains(&v), "jitter out of band: {v}");
        }
    }

    #[test]
    fn jitter_zero_base_is_zero() {
        assert_eq!(super::jitter_full(0), 0);
    }
}

#[cfg(test)]
mod validate_endpoint_tests {
    use super::*;

    #[test]
    fn validate_endpoint_http_example_com_fails() {
        let result = validate_endpoint("http://example.com");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("only allowed for localhost"));
    }

    #[test]
    fn validate_endpoint_https_example_com_succeeds() {
        let result = validate_endpoint("https://example.com");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_endpoint_http_localhost_succeeds() {
        let result = validate_endpoint("http://localhost:9000");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_endpoint_malformed_url_fails() {
        let result = validate_endpoint("https//typo.example");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not parse as a valid URL"));
    }

    #[test]
    fn validate_endpoint_http_127_0_0_1_succeeds() {
        let result = validate_endpoint("http://127.0.0.1:9000");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_endpoint_http_ipv6_loopback_succeeds() {
        let result = validate_endpoint("http://[::1]:9000");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_endpoint_ftp_fails() {
        let result = validate_endpoint("ftp://example.com");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid URL scheme"));
    }

    #[test]
    fn validate_endpoint_https_with_port_succeeds() {
        let result = validate_endpoint("https://example.com:443");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_endpoint_https_localhost_succeeds() {
        let result = validate_endpoint("https://localhost:9000");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_endpoint_empty_string_fails() {
        let result = validate_endpoint("");
        assert!(result.is_err());
    }
}
