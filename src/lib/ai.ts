// AI receipt extraction. The API key lives in the OS keyring and never
// reaches JS (set_ai_key / has_ai_key); the request runs in Rust
// (ai_extract_invoice). Provider, model and base URL are not secret and
// live in localStorage, so the feature works in local and cloud mode alike.

import { invoke } from "@tauri-apps/api/core";
import { api } from "./cloud";

const KEY = "bookie.ai";

export type AiProvider =
  "anthropic" | "openai" | "gemini" | "mistral" | "ollama";
export type AiConfig = { provider: AiProvider; model: string; baseUrl: string };

export const PROVIDERS: Record<
  AiProvider,
  { label: string; model: string; baseUrl: string; needsKey: boolean }
> = {
  anthropic: {
    label: "Anthropic (Claude)",
    model: "claude-haiku-5-5",
    baseUrl: "",
    needsKey: true,
  },
  // Any OpenAI-compatible API via baseUrl; PDFs only on api.openai.com, images everywhere.
  openai: {
    label: "OpenAI-kompatibel (OpenAI, Z.AI, OpenRouter …)",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
  },
  gemini: {
    label: "Google Gemini",
    model: "gemini-2.5-flash",
    baseUrl: "",
    needsKey: true,
  },
  mistral: {
    label: "Mistral AI",
    model: "mistral-medium-latest",
    baseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
  },
  ollama: {
    label: "Ollama (selbst gehostet)",
    model: "qwen2.5vl",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
  },
};

/** Saved config, or null when the feature was never set up / switched off. */
export function aiConfig(): AiConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return c && c.provider in PROVIDERS ? c : null;
  } catch {
    return null;
  }
}

export function saveAiConfig(c: AiConfig | null): void {
  if (c) localStorage.setItem(KEY, JSON.stringify(c));
  else localStorage.removeItem(KEY);
}

export const hasAiKey = () => invoke<boolean>("has_ai_key");
export const setAiKey = (key: string | null) => invoke("set_ai_key", { key });

export type Extracted = Partial<{
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  netAmount: string;
  taxAmount: string;
}>;

// Models answer `19,99`, `"1.234,50"` or 19.99; anything else is dropped.
function amount(v: unknown): string | undefined {
  if (typeof v === "number")
    return Number.isFinite(v) ? v.toFixed(2) : undefined;
  if (typeof v !== "string") return undefined;
  let s = v.replace(/[^\d,.-]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n.toFixed(2) : undefined;
}

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Pulls the form fields out of the model's answer; invalid fields are left out. */
export function parseExtraction(text: string): Extracted {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("KI-Antwort enthält kein JSON");
  const j = JSON.parse(m[0]);
  const date = str(j.invoice_date);
  const out: Extracted = {
    supplierName: str(j.supplier_name),
    invoiceNumber: str(j.invoice_number),
    invoiceDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    netAmount: amount(j.net_amount),
    taxAmount: amount(j.tax_amount),
  };
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== undefined),
  ) as Extracted;
}

/** Sends the receipt to the configured provider (via Rust) and parses the answer. */
export async function extractInvoice(
  file: File,
  c: AiConfig,
): Promise<Extracted> {
  const text = await invoke<string>(
    "ai_extract_invoice",
    new Uint8Array(await file.arrayBuffer()),
    {
      headers: {
        "x-bookie-args": encodeURIComponent(
          JSON.stringify({ ...c, mimeType: file.type || "application/pdf" }),
        ),
      },
    },
  );
  return parseExtraction(text);
}

/** Text-only completion (Finanzberater) via the configured provider; same key, same Rust path. */
export function complete(
  system: string,
  prompt: string,
  c: AiConfig,
): Promise<string> {
  return invoke<string>("ai_complete", { args: { ...c, system, prompt } });
}

/** Cloud mode: bookie-server reads the receipt (Mistral OCR), no own key or config needed. */
export async function extractInvoiceCloud(file: File): Promise<Extracted> {
  const x = await api<Record<string, unknown>>(
    "/api/incoming-invoices/extract",
    "POST",
    file,
  );
  const euros = (c: unknown) => (typeof c === "number" ? c / 100 : null);
  return parseExtraction(
    JSON.stringify({
      ...x,
      net_amount: euros(x.net_cents),
      tax_amount: euros(x.tax_cents),
    }),
  );
}
