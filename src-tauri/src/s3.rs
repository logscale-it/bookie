//! Minimal S3 REST client: SigV4 signing via `aws-sigv4` (Amazon's official
//! signing crate) + blocking HTTP via `ureq`/rustls.
//!
//! Replaces `aws-sdk-s3` and its smithy/hyper/tower transport stack (~6MB of
//! release binary) for the four operations Bookie actually uses: PUT / GET /
//! DELETE object and presigned GET URLs. Path-style addressing when a custom
//! endpoint is configured (MinIO), virtual-hosted style for AWS default.
//!
//! All calls are blocking — command handlers wrap them in
//! `tauri::async_runtime::spawn_blocking`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{Duration, SystemTime};

use aws_credential_types::Credentials;
use aws_sigv4::http_request::{
    sign, PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest,
    SignatureLocation, SigningSettings, UriPathNormalizationMode,
};
use aws_sigv4::sign::v4;
use aws_smithy_runtime_api::client::identity::Identity;

use sha2::{Digest, Sha256};

use crate::IsRetryable;

/// Response bodies (DB backups) can be large; ureq's default `read_to_vec`
/// cap is 10MB, so every read passes this explicit limit instead. Streaming
/// paths (`get_object_to_file`) spill to disk, so this bounds disk usage per
/// response, not RAM.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Copy-loop buffer for the streaming upload/download paths.
const STREAM_BUF_BYTES: usize = 64 * 1024;

/// Cap on the error-XML excerpt read from a failed streaming request.
const ERROR_EXCERPT_BYTES: u64 = 64 * 1024;

/// Lowercase hex SHA-256 of everything `reader` yields, via a fixed 64 KB
/// buffer. Shared by the two streaming paths; `lib.rs` keeps its own
/// slice-based `sha256_hex` for in-memory payloads.
pub(crate) fn sha256_hex_reader(reader: &mut impl Read) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; STREAM_BUF_BYTES];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Errors from the minimal S3 client.
#[derive(Debug)]
pub enum S3Error {
    /// DNS / connect / TLS / timeout / read failures — transient.
    Transport(String),
    /// Server responded with a non-2xx status. Carries a short body excerpt
    /// (S3 error XML) for the logs.
    Status(u16, String),
    /// Request construction or signing failed — a bug, never retried.
    Construction(String),
}

impl S3Error {
    pub fn status_code(&self) -> Option<u16> {
        match self {
            S3Error::Status(code, _) => Some(*code),
            _ => None,
        }
    }
}

impl std::fmt::Display for S3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            S3Error::Transport(msg) => write!(f, "network/TLS error: {msg}"),
            S3Error::Status(code, detail) => write!(f, "status={code}, detail={detail}"),
            S3Error::Construction(msg) => write!(f, "request construction failed: {msg}"),
        }
    }
}

impl IsRetryable for S3Error {
    fn is_retryable(&self) -> bool {
        match self {
            S3Error::Transport(_) => true,
            S3Error::Status(code, _) => *code >= 500 || *code == 429,
            S3Error::Construction(_) => false,
        }
    }
}

// Debug: `Credentials` redacts the secret key in its Debug impl, so deriving
// here does not leak credentials into logs or test failure output.
#[derive(Clone, Debug)]
pub struct S3Client {
    /// Validated custom endpoint without trailing slash (path-style
    /// addressing), or `None` for the AWS default endpoint (virtual-hosted).
    endpoint: Option<String>,
    region: String,
    bucket: String,
    credentials: Credentials,
    agent: ureq::Agent,
}

impl S3Client {
    pub fn new(
        endpoint: Option<String>,
        region: String,
        bucket: String,
        access_key_id: &str,
        secret_access_key: &str,
    ) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            // Non-2xx responses come back as plain responses so status
            // mapping stays in one place (`send`).
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            // Bounds a hung transfer; large backups stay comfortably inside.
            .timeout_global(Some(Duration::from_secs(600)))
            .build()
            .into();
        Self {
            endpoint,
            region,
            bucket,
            credentials: Credentials::new(access_key_id, secret_access_key, None, None, "bookie"),
            agent,
        }
    }

    /// Percent-encode a key for the request path: every byte except the SigV4
    /// unreserved set (`A-Za-z0-9-._~`) and the `/` separators. This is the
    /// exact canonical-URI encoding SigV4 specifies for S3, so the signed
    /// path and the transmitted path always agree.
    fn encode_key(key: &str) -> String {
        let mut out = String::with_capacity(key.len());
        for &b in key.as_bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                    out.push(b as char)
                }
                _ => {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
        out
    }

    /// Full URL for `key` (empty `key` addresses the bucket itself).
    fn object_url(&self, key: &str) -> String {
        let encoded = Self::encode_key(key);
        match &self.endpoint {
            Some(ep) => format!("{ep}/{bucket}/{encoded}", bucket = self.bucket),
            None => format!(
                "https://{bucket}.s3.{region}.amazonaws.com/{encoded}",
                bucket = self.bucket,
                region = self.region
            ),
        }
    }

    /// SigV4 settings for S3: payload hash in `x-amz-content-sha256`, no
    /// double URI encoding, no path normalization (matches what the AWS SDK
    /// configures for the S3 service specifically).
    fn base_settings() -> SigningSettings {
        let mut settings = SigningSettings::default();
        settings.payload_checksum_kind = PayloadChecksumKind::XAmzSha256;
        settings.percent_encoding_mode = PercentEncodingMode::Single;
        settings.uri_path_normalization_mode = UriPathNormalizationMode::Disabled;
        settings
    }

    /// Sign `method key` with the given settings/body and return the signed
    /// `http::Request` ready to execute.
    fn build_signed_request<B>(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        signable_body: SignableBody<'_>,
        body: B,
        settings: SigningSettings,
    ) -> Result<http::Request<B>, S3Error> {
        let identity: Identity = self.credentials.clone().into();
        let params: aws_sigv4::http_request::SigningParams<'_> = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name("s3")
            .time(SystemTime::now())
            .settings(settings)
            .build()
            .map_err(|e| S3Error::Construction(e.to_string()))?
            .into();

        let signable = SignableRequest::new(method, url, headers.iter().copied(), signable_body)
            .map_err(|e| S3Error::Construction(e.to_string()))?;

        let (instructions, _signature) = sign(signable, &params)
            .map_err(|e| S3Error::Construction(e.to_string()))?
            .into_parts();

        let mut builder = http::Request::builder().method(method).uri(url);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let mut request = builder
            .body(body)
            .map_err(|e| S3Error::Construction(e.to_string()))?;
        instructions.apply_to_request_http1x(&mut request);
        Ok(request)
    }

    /// Execute a signed request; 2xx returns the response body, anything else
    /// maps to `S3Error::Status` with a short excerpt of the S3 error XML.
    fn send(
        &self,
        method: &str,
        key: &str,
        body: &[u8],
        content_type: Option<&str>,
    ) -> Result<Vec<u8>, S3Error> {
        let url = self.object_url(key);
        let mut headers: Vec<(&str, &str)> = Vec::new();
        if let Some(ct) = content_type {
            headers.push(("content-type", ct));
        }
        // `&[u8]` implements ureq's `AsSendBody` with a known length, so the
        // slice is sent as-is with Content-Length — no owned copy needed.
        let request = self.build_signed_request(
            method,
            &url,
            &headers,
            SignableBody::Bytes(body),
            body,
            Self::base_settings(),
        )?;

        let response = self
            .agent
            .run(request)
            .map_err(|e| S3Error::Transport(e.to_string()))?;

        let status = response.status().as_u16();
        let bytes = response
            .into_body()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_vec()
            .map_err(|e| S3Error::Transport(format!("response read error: {e}")))?;

        if (200..300).contains(&status) {
            Ok(bytes)
        } else {
            let excerpt: String = String::from_utf8_lossy(&bytes).chars().take(512).collect();
            Err(S3Error::Status(status, excerpt))
        }
    }

    pub fn put_object(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), S3Error> {
        self.send("PUT", key, body, Some(content_type)).map(|_| ())
    }

    pub fn get_object(&self, key: &str) -> Result<Vec<u8>, S3Error> {
        self.send("GET", key, &[], None)
    }

    pub fn delete_object(&self, key: &str) -> Result<(), S3Error> {
        self.send("DELETE", key, &[], None).map(|_| ())
    }

    /// Presigned GET URL: signature moves into the query string, payload is
    /// unsigned (the standard presigned-download shape). No network I/O.
    pub fn presign_get(&self, key: &str, expires_in: Duration) -> Result<String, S3Error> {
        let url = self.object_url(key);
        let mut settings = Self::base_settings();
        settings.signature_location = SignatureLocation::QueryParams;
        settings.expires_in = Some(expires_in);
        settings.payload_checksum_kind = PayloadChecksumKind::NoHeader;

        let mut request = self.build_signed_request(
            "GET",
            &url,
            &[],
            SignableBody::UnsignedPayload,
            Vec::<u8>::new(),
            settings,
        )?;
        // apply_to_request_http1x appended the signing query params to the URI.
        Ok(std::mem::take(request.uri_mut()).to_string())
    }

    /// Create the bucket (PUT on the bucket root). Only the MinIO test
    /// fixtures need this; production buckets are provisioned by the user.
    /// Not `#[cfg(test)]` because the e2e integration tests compile the lib
    /// without `cfg(test)`.
    pub fn create_bucket(&self) -> Result<(), S3Error> {
        self.send("PUT", "", &[], None).map(|_| ())
    }

    /// PUT `path` to `key` streaming from disk: pass 1 hashes the file
    /// (SigV4 needs the payload SHA-256 before any header goes out), pass 2
    /// sends the reopened `File` as the request body — ureq derives
    /// Content-Length from its metadata, so nothing is buffered beyond a
    /// 64 KB window. Returns the lowercase hex digest so callers can reuse it
    /// for the `.sha256` sidecar without re-reading the file. Local I/O
    /// failures map to `Transport` so `with_retry` treats them like any other
    /// transient fault (each attempt reopens and re-hashes).
    pub fn put_object_from_file(
        &self,
        key: &str,
        path: &Path,
        content_type: &str,
    ) -> Result<String, S3Error> {
        let io_err = |op: &str, e: std::io::Error| {
            S3Error::Transport(format!("{op} {}: {e}", path.display()))
        };

        let mut file = File::open(path).map_err(|e| io_err("open", e))?;
        let digest_hex = sha256_hex_reader(&mut file).map_err(|e| io_err("read", e))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|e| io_err("seek", e))?;

        let url = self.object_url(key);
        let request = self.build_signed_request(
            "PUT",
            &url,
            &[("content-type", content_type)],
            SignableBody::Precomputed(digest_hex.clone()),
            file,
            Self::base_settings(),
        )?;

        let response = self
            .agent
            .run(request)
            .map_err(|e| S3Error::Transport(e.to_string()))?;

        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            Ok(digest_hex)
        } else {
            Err(Self::status_error(status, response))
        }
    }

    /// GET `key` streaming into `dest`, hashing while writing. Returns
    /// (bytes written, lowercase hex SHA-256). `MAX_RESPONSE_BYTES` caps the
    /// on-disk size; RAM usage is one 64 KB buffer. The file is fsynced
    /// before returning so a verified download survives a crash.
    pub fn get_object_to_file(&self, key: &str, dest: &Path) -> Result<(u64, String), S3Error> {
        let io_err = |op: &str, e: std::io::Error| {
            S3Error::Transport(format!("{op} {}: {e}", dest.display()))
        };

        let url = self.object_url(key);
        let request = self.build_signed_request(
            "GET",
            &url,
            &[],
            SignableBody::Bytes(&[]),
            &[][..],
            Self::base_settings(),
        )?;

        let response = self
            .agent
            .run(request)
            .map_err(|e| S3Error::Transport(e.to_string()))?;

        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(Self::status_error(status, response));
        }

        let mut body = response.into_body();
        let mut reader = body.with_config().limit(MAX_RESPONSE_BYTES).reader();
        let mut file = File::create(dest).map_err(|e| io_err("create", e))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; STREAM_BUF_BYTES];
        let mut total: u64 = 0;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| S3Error::Transport(format!("response read error: {e}")))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| io_err("write", e))?;
            total += n as u64;
        }
        file.sync_all().map_err(|e| io_err("fsync", e))?;
        Ok((total, hex_lower(&hasher.finalize())))
    }

    /// Map a non-2xx streaming response to `S3Error::Status` with a bounded
    /// excerpt of the S3 error XML (mirrors `send`'s excerpt behaviour).
    fn status_error(status: u16, response: http::Response<ureq::Body>) -> S3Error {
        let mut body = response.into_body();
        let excerpt = body
            .with_config()
            .limit(ERROR_EXCERPT_BYTES)
            .read_to_vec()
            .map(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(512)
                    .collect::<String>()
            })
            .unwrap_or_default();
        S3Error::Status(status, excerpt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(endpoint: Option<&str>) -> S3Client {
        S3Client::new(
            endpoint.map(String::from),
            "eu-central-1".into(),
            "bookie-bucket".into(),
            "AKIDEXAMPLE",
            "secret",
        )
    }

    #[test]
    fn path_style_url_for_custom_endpoint() {
        let c = client(Some("http://127.0.0.1:9100"));
        assert_eq!(
            c.object_url("backups/bookie.db"),
            "http://127.0.0.1:9100/bookie-bucket/backups/bookie.db"
        );
    }

    #[test]
    fn virtual_hosted_url_for_aws_default() {
        let c = client(None);
        assert_eq!(
            c.object_url("a/b.pdf"),
            "https://bookie-bucket.s3.eu-central-1.amazonaws.com/a/b.pdf"
        );
    }

    #[test]
    fn key_encoding_covers_spaces_and_umlauts() {
        // "Rechnung Müller.pdf" — space and ü must be percent-encoded, the
        // slash separator and unreserved chars must not.
        assert_eq!(
            S3Client::encode_key("2026/Rechnung Müller.pdf"),
            "2026/Rechnung%20M%C3%BCller.pdf"
        );
    }

    #[test]
    fn presigned_url_contains_signature_query_params() {
        let c = client(Some("http://127.0.0.1:9100"));
        let url = c
            .presign_get("backups/bookie.db", Duration::from_secs(60))
            .expect("presign is pure computation");
        assert!(url.contains("X-Amz-Signature="), "got: {url}");
        assert!(url.contains("X-Amz-Expires=60"), "got: {url}");
        assert!(url.contains("X-Amz-Credential="), "got: {url}");
    }

    #[test]
    fn status_errors_classify_for_retry() {
        assert!(S3Error::Status(500, String::new()).is_retryable());
        assert!(S3Error::Status(429, String::new()).is_retryable());
        assert!(!S3Error::Status(404, String::new()).is_retryable());
        assert!(!S3Error::Status(403, String::new()).is_retryable());
        assert!(S3Error::Transport("reset".into()).is_retryable());
        assert!(!S3Error::Construction("bad".into()).is_retryable());
    }

    #[test]
    fn status_code_accessor() {
        assert_eq!(S3Error::Status(404, String::new()).status_code(), Some(404));
        assert_eq!(S3Error::Transport(String::new()).status_code(), None);
    }
}
