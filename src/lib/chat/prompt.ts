// What the model gets. Pure, so it is testable without runes or Tauri.

import type { PageContext } from "./context.svelte";

export const SYSTEM_PROMPT = `You are the assistant inside Bookie, bookkeeping software for freelancers and small businesses in Germany. The user sees a page of the app; its figures arrive as JSON ("Page data"). Reply in the language the user writes in.

Rules:
- Answer from the supplied figures and quote them with units (EUR, hours, counts). Do not invent numbers.
- Do the arithmetic when asked (differences, shares, averages) and show the inputs in one short line.
- If the page data does not contain what is needed, say what is missing and which page of the app would have it. Do not guess.
- Short and structured: a direct answer first, then at most a few bullets. No filler, no headings, no bold spam.
- You read only; you cannot change data. For tax or legal design add one sentence that a tax advisor should confirm, and only then.`;

/** One chat turn: `text` is shown, `sent` goes to the model, `ctx` is the page JSON it carried. */
export type Turn = {
  role: "user" | "assistant";
  text: string;
  sent: string;
  ctx?: string;
  /** Assistant turns: still being revealed token by token (visual only). */
  stream?: boolean;
};

export const contextJson = (c: PageContext): string =>
  JSON.stringify({ page: c.title, ...c.facts });

/**
 * The next user turn. The first question carries the page data; a follow-up
 * is sent as typed, and re-attaches the data only when it changed since the
 * last question (page switch or new figures), so the thread stays cheap.
 */
export function userTurn(
  c: PageContext | null,
  question: string,
  thread: Turn[],
): Turn {
  const q = question.trim();
  const ctx = c ? contextJson(c) : undefined;
  const prev = thread.findLast((t) => t.role === "user");
  const attach = ctx !== undefined && ctx !== prev?.ctx;
  const sent = attach
    ? `Page data (JSON):\n${ctx}\n\nQuestion: ${q}`
    : !c && !prev
      ? `(No page data available.)\n\nQuestion: ${q}`
      : q;
  return { role: "user", text: q, sent, ctx: ctx ?? prev?.ctx };
}

export const toMessages = (thread: Turn[]) =>
  thread.map((t) => ({ role: t.role, content: t.sent }));

/** Number of leaf values in the page data, for the "Sees N values" chip. */
export function valueCount(v: unknown): number {
  if (v === null || typeof v !== "object") return 1;
  return Object.values(v).reduce<number>((n, x) => n + valueCount(x), 0);
}
