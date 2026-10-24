import { join } from "@tauri-apps/api/path";
import { api } from "./cloud";
import { writeBinaryFile } from "./fs";

type Row = Record<string, unknown>;
type Export = Row & {
  incoming_invoices: (Row & {
    id: number;
    file_name: string | null;
    receipt_url?: string;
  })[];
};

/**
 * Saves the active cloud company's data (GET /api/export, JSON) and every
 * receipt into `dir`; returns the number of receipts. Works without an active
 * subscription: a cancelled company is deleted after 90 days
 * (bookie-server src/purge.ts) and this is how its data leaves.
 */
export async function saveCloudExport(dir: string): Promise<number> {
  const data = await api<Export>("/api/export");
  const incoming = [];
  for (const { receipt_url, ...r } of data.incoming_invoices) {
    if (!receipt_url) {
      incoming.push(r);
      continue;
    }
    const res = await fetch(receipt_url);
    if (!res.ok) throw new Error(`Beleg ${r.id}: HTTP ${res.status}`);
    const file = `beleg-${r.id}-${(r.file_name || "beleg").replace(/[\\/:*?"<>|]/g, "_")}`;
    await writeBinaryFile(
      await join(dir, file),
      new Uint8Array(await res.arrayBuffer()),
    );
    incoming.push({ ...r, receipt_file: file }); // the link expires, the file name stays
  }
  await writeBinaryFile(
    await join(dir, "bookie-export.json"),
    new TextEncoder().encode(
      JSON.stringify({ ...data, incoming_invoices: incoming }, null, 2),
    ),
  );
  return incoming.filter((r) => "receipt_file" in r).length;
}
