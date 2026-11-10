/**
 * Bank statement CSV import (N26 export: "Booking Date","Value Date",
 * "Partner Name","Partner Iban",Type,"Payment Reference","Account Name",
 * "Amount (EUR)",...). Comma-separated, dot decimal, ISO dates.
 */

export interface BankTransaction {
  booking_date: string;
  value_date: string | null;
  partner_name: string;
  partner_iban: string | null;
  type: string;
  reference: string;
  account_name: string;
  /** Signed: > 0 inflow (Zufluss), < 0 outflow (Abfluss). */
  amount_cents: number;
  /** Dedup key: row content + n-th identical row in the file. */
  import_key: string;
}

/** RFC 4180 rows: quoted fields, "" escapes, commas/newlines inside quotes. */
export function parseCsv(text: string, sep = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) (row.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      (row.push(field), rows.push(row), (row = []), (field = ""));
    } else field += c;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows.filter((r) => r.some((f) => f.trim()));
}

const COLUMNS = {
  booking_date: "Booking Date",
  value_date: "Value Date",
  partner_name: "Partner Name",
  partner_iban: "Partner Iban",
  type: "Type",
  reference: "Payment Reference",
  account_name: "Account Name",
  amount: "Amount (EUR)",
} as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Throws on an unknown layout or a malformed row, so nothing half-imports. */
export function parseBankCsv(text: string): BankTransaction[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  const idx = Object.fromEntries(
    Object.entries(COLUMNS).map(([k, name]) => [
      k,
      header?.indexOf(name) ?? -1,
    ]),
  ) as Record<keyof typeof COLUMNS, number>;
  const missing = Object.entries(idx).filter(
    ([k, i]) => i < 0 && k !== "value_date",
  );
  if (missing.length)
    throw new Error(
      `CSV-Spalten fehlen: ${missing.map(([k]) => COLUMNS[k as keyof typeof COLUMNS]).join(", ")}`,
    );

  // Identical rows can be real (two equal transfers on one day), so the key
  // carries the occurrence count. Re-importing the same or an overlapping
  // export yields the same keys, as long as the export covers whole days.
  const seen = new Map<string, number>();
  return rows.map((r, n) => {
    const f = (k: keyof typeof COLUMNS) => (r[idx[k]] ?? "").trim();
    const amount = f("amount");
    if (
      r.length !== header.length ||
      !DAY.test(f("booking_date")) ||
      !/^-?\d+(\.\d{1,2})?$/.test(amount)
    )
      throw new Error(`Ungültige Zeile ${n + 2}: ${r.join(",")}`);
    const cents = Math.round(Number(amount) * 100);
    const t = {
      booking_date: f("booking_date"),
      value_date: DAY.test(f("value_date")) ? f("value_date") : null,
      partner_name: f("partner_name"),
      partner_iban: f("partner_iban").replaceAll(" ", "") || null,
      type: f("type"),
      reference: f("reference"),
      account_name: f("account_name"),
      amount_cents: cents,
    };
    const base = JSON.stringify(Object.values(t));
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return { ...t, import_key: `${base}#${k}` };
  });
}

/** Names of the owner's private accounts as stored in the setting datev_private_accounts (comma-separated). */
export const privateNames = (setting: string): string[] =>
  setting.split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);

/** A transfer without partner IBAN: either a move between Spaces of the same account or a line to the owner's own other account. */
export const isIbanlessTransfer = (b: { partner_iban: string | null; type: string }) =>
  !b.partner_iban && /transfer/i.test(b.type);

export interface UndecidedPartner {
  name: string;
  count: number;
  sumCents: number;
}

/**
 * Partners of IBAN-less transfers nobody has classified yet: not a private account
 * (setting) and not confirmed as a Space (`spaces`, lower-case). Until classified they
 * are left out of the DATEV export as internal moves, so the import asks about them.
 * Names with a comma cannot be stored in the comma-separated setting and are left out.
 */
export function undecidedPartners(
  rows: Pick<BankTransaction, "partner_name" | "partner_iban" | "type" | "amount_cents">[],
  privateAccounts: string,
  spaces: string[],
): UndecidedPartner[] {
  const known = new Set([...privateNames(privateAccounts), ...spaces]);
  const by = new Map<string, UndecidedPartner>();
  for (const r of rows) {
    const name = r.partner_name.trim();
    if (!name || name.includes(",") || !isIbanlessTransfer(r) || known.has(name.toLowerCase())) continue;
    const p = by.get(name.toLowerCase()) ?? { name, count: 0, sumCents: 0 };
    p.count++;
    p.sumCents += r.amount_cents;
    by.set(name.toLowerCase(), p);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

const SPACES_KEY = "bookie.datevSpaces";

/** Partner names the user confirmed as Spaces (internal moves), lower-case; per device. */
export function loadSpaces(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SPACES_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveSpaces(names: string[]): void {
  try {
    localStorage.setItem(SPACES_KEY, JSON.stringify([...new Set([...loadSpaces(), ...names.map((n) => n.toLowerCase())])]));
  } catch {
    /* private mode: asked again next import */
  }
}
