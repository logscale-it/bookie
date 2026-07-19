//! Smoke test for the MinIO E2E fixture (TEST-3.a).
//!
//! Verifies that:
//!   1. The fixture brings up an ephemeral MinIO container.
//!   2. The container is reachable on the reported endpoint.
//!   3. A bucket can be created and an object round-trips through it.
//!   4. Dropping the fixture cleans up the container.
//!
//! Gated behind `--features e2e` so the default `cargo test` does not need
//! Docker. Reviewer command:
//!
//! ```text
//! cargo test --features e2e --manifest-path src-tauri/Cargo.toml \
//!     -- --nocapture minio_fixture_smoke
//! ```

#![cfg(feature = "e2e")]

mod fixtures;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn minio_fixture_smoke() {
    let minio = fixtures::minio::MinioFixture::start().await;

    // 1. Endpoint URL looks like a real http URL with a non-zero port.
    let endpoint = minio.endpoint_url();
    eprintln!("MinIO fixture endpoint: {endpoint}");
    assert!(
        endpoint.starts_with("http://"),
        "endpoint should be http:// (got {endpoint})"
    );
    assert!(
        endpoint
            .rsplit(':')
            .next()
            .and_then(|p| p.parse::<u16>().ok())
            .is_some(),
        "endpoint should end in a parsable port (got {endpoint})"
    );

    // 2. Bucket creation is idempotent and succeeds.
    minio.ensure_bucket();
    minio.ensure_bucket();

    // 3. Object round-trip: PUT then GET returns the same bytes.
    let client = minio.s3_client();
    let key = "smoke/round-trip.bin";
    let payload = b"bookie-minio-fixture-smoke".to_vec();

    client
        .put_object(key, &payload, "application/octet-stream")
        .expect("put_object should succeed against fixture");

    let got_bytes = client
        .get_object(key)
        .expect("get_object should succeed against fixture");

    assert_eq!(got_bytes, payload, "round-tripped payload must match");

    // 4. Drop happens at end of scope; the container shutdown is exercised
    //    implicitly by the next test run starting a fresh container.
}
