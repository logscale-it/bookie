//! E2E round-trip for the streaming S3 paths (`put_object_from_file` /
//! `get_object_to_file`) that back the DB backup/restore flows.
//!
//! Verifies against a real MinIO container that:
//!   1. A file uploads from disk with a precomputed-SHA256 SigV4 signature
//!      (Content-Length body, no chunked encoding) and the returned digest
//!      matches the file's actual SHA-256.
//!   2. Downloading to a file yields byte-identical content, and the
//!      hash-while-writing digest matches the upload digest.
//!   3. The non-streaming `get_object` sees the same bytes (cross-path
//!      compatibility with the sidecar/verification flows).
//!
//! Gated behind `--features e2e` so the default `cargo test` does not need
//! Docker. Reviewer command:
//!
//! ```text
//! cargo test --features e2e --manifest-path src-tauri/Cargo.toml \
//!     --test streaming_s3_e2e -- --nocapture
//! ```

#![cfg(feature = "e2e")]

mod fixtures;

use std::fs;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streaming_put_get_round_trip() {
    let minio = fixtures::minio::MinioFixture::start().await;
    minio.ensure_bucket();
    let client = minio.s3_client();

    // Payload deliberately larger than the 64 KB stream buffer so the copy
    // loop runs multiple iterations, with non-repeating content so offset
    // bugs can't cancel out.
    let payload: Vec<u8> = (0u32..200_000).flat_map(|i| i.to_le_bytes()).collect();

    let dir = std::env::temp_dir().join(format!("bookie-streaming-e2e-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create temp dir");
    let src = dir.join("upload.bin");
    let dst = dir.join("download.bin");
    fs::write(&src, &payload).expect("write source file");

    let key = "streaming/round-trip.bin";
    let upload_digest = client
        .put_object_from_file(key, &src, "application/octet-stream")
        .expect("streaming upload should succeed");
    assert_eq!(upload_digest.len(), 64, "digest is lowercase sha256 hex");

    let (bytes_written, download_digest) = client
        .get_object_to_file(key, &dst)
        .expect("streaming download should succeed");
    assert_eq!(bytes_written, payload.len() as u64);
    assert_eq!(
        download_digest, upload_digest,
        "hash-while-writing digest must match the upload digest"
    );

    let round_tripped = fs::read(&dst).expect("read downloaded file");
    assert_eq!(round_tripped, payload, "downloaded bytes must be identical");

    // Cross-path check: the buffered GET sees the same object.
    let buffered = client
        .get_object(key)
        .expect("buffered get_object should succeed");
    assert_eq!(buffered, payload);

    let _ = fs::remove_dir_all(&dir);
}
