// What the open page tells the chat panel: a small plain object of the numbers
// the user is looking at. Pages publish from an $effect; the panel reads it
// when a question is sent (and shows it, so the user sees what leaves the app).

export type PageContext = {
  /** Route key, e.g. "uebersicht"; also decides which quick prompts show. */
  page: string;
  /** Human title shown in the panel, e.g. "Übersicht 2026". */
  title: string;
  /** Only what is on screen: totals, period, a few top rows. Never raw tables. */
  facts: Record<string, unknown>;
};

let current = $state<PageContext | null>(null);

export const pageContext = {
  get current(): PageContext | null {
    return current;
  },
};

/**
 * `$effect(() => publishContext({...}))`: republishes when the reads inside
 * change and clears on teardown, but only if no newer page took over.
 */
export function publishContext(c: PageContext): () => void {
  current = c;
  return () => {
    if (current === c) current = null;
  };
}
