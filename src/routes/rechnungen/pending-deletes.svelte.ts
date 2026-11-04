// Invoice ids whose delete is waiting out its undo window (see deferDelete).
// The detail page adds the id and navigates back; the list hides those rows.
import { SvelteSet } from "svelte/reactivity";

export const pendingDeletes = new SvelteSet<number>();
