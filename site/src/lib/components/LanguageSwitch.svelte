<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { counterpart } from "$lib/i18n";

  let { isDe }: { isDe: boolean } = $props();

  // Same page in the other language, falling back to that language's home.
  const href = $derived(
    counterpart(page.url.pathname) ?? (isDe ? `${base}/` : `${base}/de/`),
  );
</script>

<a
  {href}
  class="grid grid-cols-2 rounded-full border border-zinc-200 bg-white p-0.5 text-xs font-semibold dark:border-zinc-800 dark:bg-zinc-900"
  aria-label={isDe ? "Switch to English" : "Zu Deutsch wechseln"}
  hreflang={isDe ? "en" : "de"}
>
  <span
    class="rounded-full px-2 py-0.5 text-center leading-6"
    class:bg-blue-600={!isDe}
    class:text-white={!isDe}
  >
    EN
  </span>
  <span
    class="rounded-full px-2 py-0.5 text-center leading-6"
    class:bg-blue-600={isDe}
    class:text-white={isDe}
  >
    DE
  </span>
</a>
