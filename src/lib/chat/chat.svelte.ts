// Chat panel state: open mode, the thread, the in-flight request. The panel
// is a view on this; sending goes through the existing `complete()` (key in the
// OS keyring, Rust does the request), with the open page's data attached.

import { aiConfig, complete } from "$lib/ai";
import { pageContext } from "./context.svelte";
import { SYSTEM_PROMPT, toMessages, userTurn, type Turn } from "./prompt";

export type ChatMode = "closed" | "docked" | "wide";

export const chat = $state({
  mode: "closed" as ChatMode,
  turns: [] as Turn[],
  busy: false,
  error: "",
});

let gen = 0;

export const toggleChat = () => {
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
  if (!question.trim() || chat.busy || !cfg) return false;
  const mine = gen;
  const turn = userTurn(pageContext.current, question, chat.turns);
  chat.turns.push(turn);
  chat.busy = true;
  chat.error = "";
  try {
    const text = await complete(SYSTEM_PROMPT, toMessages(chat.turns), cfg);
    if (mine !== gen) return false;
    chat.turns.push({ role: "assistant", text, sent: text });
    return true;
  } catch (e) {
    if (mine !== gen) return false;
    chat.turns.pop();
    chat.error = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    if (mine === gen) chat.busy = false;
  }
}
