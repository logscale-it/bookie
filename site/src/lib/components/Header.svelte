<script lang="ts">
  import { base } from "$app/paths";
  import { REPO_URL } from "$lib/site";
  import LanguageSwitch from "./LanguageSwitch.svelte";

  let { isDe }: { isDe: boolean } = $props();

  const featuresHref = $derived(
    isDe ? `${base}/de/#features` : `${base}/#features`,
  );
  const downloadHref = $derived(
    isDe ? `${base}/de/#download` : `${base}/#download`,
  );
  const pricingHref = $derived(
    isDe ? `${base}/de/preise/` : `${base}/pricing/`,
  );
</script>

<header
  class="sticky top-0 z-50 border-b border-zinc-200 bg-zinc-50/80 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/80"
>
  <div class="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
    <a
      href={`${base}/`}
      class="flex items-center gap-2.5"
      aria-label="Bookie home"
    >
      <img src={`${base}/favicon.svg`} alt="" class="h-7 w-7 rounded-lg" />
      <span class="text-base font-semibold tracking-tight">Bookie</span>
    </a>
    <nav class="flex items-center gap-6">
      <a
        href={featuresHref}
        class="text-sm font-medium text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        {isDe ? "Funktionen" : "Features"}
      </a>
      <a
        href={pricingHref}
        class="text-sm font-medium text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        {isDe ? "Preise" : "Pricing"}
      </a>
      <a
        href={downloadHref}
        class="hidden text-sm font-medium text-zinc-500 transition hover:text-zinc-900 sm:inline dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        {isDe ? "Herunterladen" : "Download"}
      </a>
      <LanguageSwitch {isDe} />
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener"
        aria-label="View on GitHub"
        class="text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"
          ><path
            d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
          /></svg
        >
      </a>
    </nav>
  </div>
</header>
