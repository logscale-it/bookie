//! Regression: `init_tracing` used to call `LogTracer::init()` before
//! `try_init()`, which installs it again and fails. The error dropped the
//! WorkerGuard, killing the file writer, so every daily log stayed 0 bytes.
//! Own test binary because it installs the process-global subscriber.

#[test]
fn init_tracing_writes_tracing_and_log_lines_to_file() {
    let dir = std::env::temp_dir().join(format!("bookie-tracing-init-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    let guard = bookie_lib::init_tracing(&dir).expect("init_tracing must succeed");
    tracing::info!("hello-from-tracing");
    log::info!("hello-from-log");
    drop(guard); // flush the non-blocking writer

    let contents: String = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
        .collect();
    assert!(contents.contains("hello-from-tracing"), "log file: {contents:?}");
    assert!(contents.contains("hello-from-log"), "log file: {contents:?}");
    let _ = std::fs::remove_dir_all(&dir);
}
