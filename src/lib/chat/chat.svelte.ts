// Chat panel state: open mode, the thread, the in-flight request. The panel
// is a view on this; sending goes through the existing `complete()` (key in the
// OS keyring, Rust does the request), with the open page's data attached.

import { aiConfig, aiUsage, complete, completeCloud } from "$lib/ai";
import { cloud, CloudError } from "$lib/cloud";
import { isSub } from "$lib/session.svelte";
import { pageContext } from "./context.svelte";
import { SYSTEM_PROMPT, toMessages, userTurn, type Turn } from "./prompt";

export type ChatMode = "closed" | "docked" | "wide";

export const chat = $state({
  mode: "closed" as ChatMode,
  turns: [] as Turn[],
  busy: false,
  error: "",
  /** Cloud only: this month's requests used and allowed for the company. */
  quota: null as { used: number; limit: number } | null,
});

let gen = 0;

export const toggleChat = () => {
  if (isSub()) return; // subcontractors have no assistant (server: 403)
  chat.mode = chat.mode === "closed" ? "docked" : "closed";
};

/** New conversation (company switch, "clear"); a late answer to the old one is dropped. */
export function resetChat(): void {
  gen++;
  chat.turns = [];
  chat.busy = false;
  chat.error = "";
}

/** True when the question was answered; false leaves the thread as it was so the draft can be restored. */
export async function sendChat(question: string): Promise<boolean> {
  const cfg = aiConfig();
  const inCloud = cloud() !== null; // cloud wins, like receipt OCR: the server key and quota apply
  if (!question.trim() || chat.busy || (!inCloud && !cfg)) return false;
  const mine = gen;
  const turn = userTurn(pageContext.current, question, chat.turns);
  chat.turns.push(turn);
  chat.busy = true;
  chat.error = "";
  try {
    let text: string;
    if (inCloud) {
      const r = await completeCloud(toMessages(chat.turns));
      text = r.text;
      if (mine === gen) chat.quota = { used: r.used, limit: r.limit };
    } else text = await complete(SYSTEM_PROMPT, toMessages(chat.turns), cfg!);
    if (mine !== gen) return false;
    chat.turns.push({ role: "assistant", text, sent: text, stream: true });
    return true;
  } catch (e) {
    if (mine !== gen) return false;
    chat.turns.pop();
    if (inCloud && e instanceof CloudError && e.code === "quota_exceeded")
      aiUsage().then((u) => (chat.quota = { used: u.used, limit: u.limit })).catch(() => {});
    chat.error = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    if (mine === gen) chat.busy = false;
  }
}
