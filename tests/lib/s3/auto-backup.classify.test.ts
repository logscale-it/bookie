import { test, expect, describe } from "bun:test";
import { classifyBackupError } from "../../../src/lib/s3/auto-backup";

describe("classifyBackupError", () => {
  test("403 / AccessDenied -> auth_error", () => {
    expect(classifyBackupError(new Error("403 Forbidden"))).toBe("auth_error");
    expect(classifyBackupError(new Error("AccessDenied"))).toBe("auth_error");
    expect(classifyBackupError(new Error("InvalidAccessKeyId"))).toBe(
      "auth_error",
    );
    expect(classifyBackupError(new Error("SignatureDoesNotMatch"))).toBe(
      "auth_error",
    );
    expect(classifyBackupError(new Error("Unauthorized request"))).toBe(
      "auth_error",
    );
  });

  test("NoSuchBucket / 404 -> bucket_not_found", () => {
    expect(classifyBackupError(new Error("NoSuchBucket"))).toBe(
      "bucket_not_found",
    );
    expect(classifyBackupError(new Error("HTTP 404"))).toBe("bucket_not_found");
  });

  test("network/timeout -> network_error", () => {
    expect(classifyBackupError(new Error("request timed out"))).toBe(
      "network_error",
    );
    expect(classifyBackupError(new Error("Network unreachable"))).toBe(
      "network_error",
    );
    expect(classifyBackupError(new Error("ECONNREFUSED 127.0.0.1"))).toBe(
      "network_error",
    );
    expect(classifyBackupError(new Error("DNS lookup failed"))).toBe(
      "network_error",
    );
  });

  test("local backup failure -> local_backup_error", () => {
    expect(
      classifyBackupError(new Error("backup_database invocation failed")),
    ).toBe("local_backup_error");
    expect(classifyBackupError(new Error("sqlite I/O error"))).toBe(
      "local_backup_error",
    );
  });

  test("anything else -> unknown_error", () => {
    expect(classifyBackupError(new Error("random failure"))).toBe(
      "unknown_error",
    );
    expect(classifyBackupError("plain string")).toBe("unknown_error");
    expect(classifyBackupError(undefined)).toBe("unknown_error");
  });
});
