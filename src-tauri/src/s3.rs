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

use std::time::{Duration, SystemTime};

use aws_credential_types::Credentials;
use aws_sigv4::http_request::{
    sign, PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest,
    SignatureLocation, SigningSettings, UriPathNormalizationMode,
};
use aws_sigv4::sign::v4;
use aws_smithy_runtime_api::client::identity::Identity;

use crate::IsRetryable;

/// Response bodies (DB backups) can be large; ureq's default `read_to_vec`
/// cap is 10MB, so every read passes this explicit limit instead.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

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
    fn build_signed_request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        signable_body: SignableBody<'_>,
        body: Vec<u8>,
        settings: SigningSettings,
    ) -> Result<http::Request<Vec<u8>>, S3Error> {
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
        let request = self.build_signed_request(
            method,
            &url,
            &headers,
            SignableBody::Bytes(body),
            body.to_vec(),
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
            Vec::new(),
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
