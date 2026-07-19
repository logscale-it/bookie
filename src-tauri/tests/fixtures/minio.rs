//! Ephemeral MinIO container fixture for end-to-end S3 round-trip tests.
//!
//! TEST-3.a — refinement step that unblocks the full
//! "create draft -> issue -> record payment -> back up to S3 -> restore on
//! a fresh DB and compare byte-for-byte" lifecycle test (TEST-3.b, #89).
//!
//! # Why a real MinIO and not a pure-Rust mock
//!
//! The production code path uses the real `bookie_lib::s3` client, which
//! performs V4 signing and path-style routing. A real MinIO container
//! exercises the same wire format the production app talks to, so we catch
//! issues that an in-process mock (which typically only matches a curated
//! subset of operations) silently ignores. Tradeoff: tests need a Docker
//! daemon, so this fixture lives behind the `e2e` cargo feature and the
//! corresponding tests are skipped from the default `cargo test`.
//!
//! # Usage
//!
//! ```ignore
//! mod fixtures;
//!
//! #[tokio::test(flavor = "multi_thread")]
//! async fn my_e2e_test() {
//!     let minio = fixtures::minio::MinioFixture::start().await;
//!     minio.ensure_bucket();
//!
//!     // Build the production S3 client wired to the fixture:
//!     let client = minio.s3_client();
//!     // ... exercise round-trip ...
//! }
//! ```
//!
//! The container is killed automatically when the [`MinioFixture`] is dropped
//! (handled by `testcontainers`'s `ContainerAsync` `Drop` impl).
//!
//! TEST-3.b will use this fixture to drive the full lifecycle test.

// Each integration-test target compiles this module separately; accessors
// used by one target look dead to another. Suppress per-target dead-code
// noise for the shared fixture.
#![allow(dead_code)]

use std::time::Duration;

use bookie_lib::s3::S3Client;
use testcontainers::{runners::AsyncRunner, ContainerAsync, ImageExt};
use testcontainers_modules::minio::MinIO;

/// Default credentials baked into the upstream `minio/minio` image. The
/// fixture does not let callers override these because the only consumer is
/// the in-process test process: there is no security boundary to defend.
pub const ACCESS_KEY: &str = "minioadmin";
pub const SECRET_KEY: &str = "minioadmin";

/// Region string used for the test fixture. MinIO ignores it for routing
/// (it is single-tenant), but the SigV4 signing scope requires a value.
pub const REGION: &str = "us-east-1";

/// Default bucket name created by [`MinioFixture::ensure_bucket`]. Tests that
/// need isolation between runs should still scope object keys with a unique
/// prefix (e.g. a nanosecond timestamp).
pub const DEFAULT_BUCKET: &str = "bookie-test";

/// Handle to a running ephemeral MinIO container.
///
/// The underlying `ContainerAsync` is kept inside the struct so that dropping
/// the fixture stops and removes the container. Do not forget to bind the
/// fixture to a local variable for the duration of the test — otherwise it
/// will be dropped at the end of the statement and the container will go away
/// before the test body executes.
pub struct MinioFixture {
    /// Kept alive for `Drop` side effects; not read directly.
    _container: ContainerAsync<MinIO>,
    endpoint_url: String,
    bucket: String,
}

impl MinioFixture {
    /// Start a fresh MinIO container and wait until it is reachable.
    ///
    /// Panics on failure. End-to-end fixtures are intentionally noisy so a
    /// missing Docker daemon surfaces as an obvious test failure rather than
    /// a silent skip.
    pub async fn start() -> Self {
        Self::start_with_bucket(DEFAULT_BUCKET).await
    }

    /// Like [`Self::start`] but lets the caller pick the default bucket name.
    pub async fn start_with_bucket(bucket: &str) -> Self {
        // `with_startup_timeout` guards against pathological pulls on cold
        // CI runners. The default `WaitFor` strategy from the module already
        // waits for MinIO's "API:" log line before returning.
        let container = MinIO::default()
            .with_startup_timeout(Duration::from_secs(120))
            .start()
            .await
            .expect("failed to start MinIO container; is Docker running?");

        let host = container
            .get_host()
            .await
            .expect("failed to read container host");
        let port = container
            .get_host_port_ipv4(9000)
            .await
            .expect("failed to read mapped MinIO API port");

        let endpoint_url = format!("http://{host}:{port}");

        Self {
            _container: container,
            endpoint_url,
            bucket: bucket.to_string(),
        }
    }

    /// Endpoint URL the production `S3Config::build_client` should be pointed
    /// at to talk to this fixture (e.g. `http://127.0.0.1:49321`).
    pub fn endpoint_url(&self) -> &str {
        &self.endpoint_url
    }

    pub fn region(&self) -> &str {
        REGION
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    pub fn access_key_id(&self) -> &str {
        ACCESS_KEY
    }

    pub fn secret_access_key(&self) -> &str {
        SECRET_KEY
    }

    /// Build the production `bookie_lib::s3::S3Client` wired to the fixture
    /// (custom endpoint → path-style addressing, exactly like
    /// `S3Config::build_client`).
    pub fn s3_client(&self) -> S3Client {
        S3Client::new(
            Some(self.endpoint_url.clone()),
            REGION.to_string(),
            self.bucket.clone(),
            ACCESS_KEY,
            SECRET_KEY,
        )
    }

    /// Create the default bucket if it does not already exist. Idempotent —
    /// safe to call from multiple tests sharing the same fixture instance.
    /// We deliberately swallow the "already exists" error; any other
    /// failure will surface in the next operation.
    pub fn ensure_bucket(&self) {
        let _ = self.s3_client().create_bucket();
    }
}
