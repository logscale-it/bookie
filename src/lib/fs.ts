import { invoke } from "@tauri-apps/api/core";

/**
 * Raw-body IPC to the Rust `write_binary_file` command: the bytes travel as
 * the invoke body (no JSON number array — that shape boxed every byte into a
 * JS number on the way in, ~8× the file size transiently), the target path
 * percent-encoded in the `x-bookie-path` header because header values must
 * be ASCII while user-chosen paths may not be.
 */
export async function writeBinaryFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await invoke("write_binary_file", bytes, {
    headers: { "x-bookie-path": encodeURIComponent(path) },
  });
}
