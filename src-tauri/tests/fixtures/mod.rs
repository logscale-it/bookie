//! Reusable test fixtures for backend integration tests.
//!
//! All fixtures here are gated behind the `e2e` cargo feature so the default
//! `cargo test` invocation does not require Docker. Run the e2e suite with:
//!
//! ```text
//! cargo test --features e2e --manifest-path src-tauri/Cargo.toml
//! ```

#[cfg(feature = "e2e")]
pub mod minio;
