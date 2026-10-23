import { t } from "$lib/i18n";
import type { EInvoiceIssue } from "./validate";

/** Fields whose "invalid" message says what a valid value looks like (einvoice.invalidHint). */
const INVALID_HINTS: Record<string, string> = {
  "seller.vatId": "vatId",
  "buyer.vatId": "vatId",
  "seller.bankIban": "iban",
  "seller.bankBic": "bic",
};

/**
 * One human-readable line per issue, e.g. "Position 2: Menge ungültig (BR-22)". An invalid
 * VAT ID, IBAN or BIC also says what is expected, so the user knows how to fix it.
 */
export function describeIssue(i: EInvoiceIssue): string {
  const idx = /^(?:items|taxGroups)\[(\d+)\]/.exec(i.field);
  const pos =
    idx && i.field.startsWith("items")
      ? `${t("einvoice.position")} ${+idx[1] + 1}: `
      : "";
  const field = i.field.replace(/\[\d+\]/g, "");
  const label = t(`einvoice.fields.${field}`);
  const hint = i.code === "invalid" ? INVALID_HINTS[field] : undefined;
  const detail = hint ? `: ${t(`einvoice.invalidHint.${hint}`)}` : "";
  return `${pos}${label} ${t(`einvoice.issue.${i.code}`)}${detail} (${i.rule})`;
}
