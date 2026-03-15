/**
 * German Finanzamt-compatible CSV utilities.
 * - Semicolon separator
 * - Comma decimal separator for EUR amounts
 * - UTF-8 with BOM for Excel compatibility
 */

import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

const BOM = "\uFEFF";

export function formatDeCurrency(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

export function buildCsvString(
  headers: string[],
  rows: string[][],
  metaRows?: string[][],
): string {
  const lines: string[] = [];
  if (metaRows) {
    for (const row of metaRows) {
      lines.push(row.join(";"));
    }
    lines.push("");
  }
  lines.push(headers.join(";"));
  for (const row of rows) {
    lines.push(row.join(";"));
  }
  return BOM + lines.join("\r\n") + "\r\n";
}

export async function saveCsvFile(
  csvString: string,
  defaultFileName: string,
): Promise<boolean> {
  const filePath = await save({
    title: "CSV exportieren",
    defaultPath: defaultFileName,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!filePath) return false;

  const encoder = new TextEncoder();
  const bytes = encoder.encode(csvString);
  await invoke("write_binary_file", {
    path: filePath,
    data: Array.from(bytes),
  });
  return true;
}
