<script lang="ts">
  import { base } from "$app/paths";
  import { slide } from "svelte/transition";
  import { REPO_URL } from "$lib/site";
  import LanguageSwitch from "./LanguageSwitch.svelte";

  let { isDe }: { isDe: boolean } = $props();

  let menuOpen = $state(false);

  const featuresHref = $derived(
    isDe ? `${base}/de/#features` : `${base}/#features`,
  );
  const downloadHref = $derived(
    isDe ? `${base}/de/#download` : `${base}/#download`,
  );
  const pricingHref = $derived(
    isDe ? `${base}/de/#preise` : `${base}/#pricing`,
  );

  const links = $derived([
    { href: featuresHref, label: isDe ? "Funktionen" : "Features" },
    { href: pricingHref, label: isDe ? "Preise" : "Pricing" },
    { href: downloadHref, label: isDe ? "Herunterladen" : "Download" },
  ]);
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

    <!-- Desktop navigation -->
    <nav class="hidden items-center gap-6 sm:flex">
      {#each links as link (link.href)}
        <a
          href={link.href}
          class="text-sm font-medium text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          {link.label}
        </a>
      {/each}
    </nav>

    <div class="flex items-center gap-4 sm:gap-6">
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
      <!-- Burger menu (mobile only) -->
      <button
        type="button"
        class="sm:hidden"
        aria-expanded={menuOpen}
        aria-controls="mobile-menu"
        aria-label={menuOpen
          ? isDe
            ? "Menü schließen"
            : "Close menu"
          : isDe
            ? "Menü öffnen"
            : "Open menu"}
        onclick={() => (menuOpen = !menuOpen)}
      >
        {#if menuOpen}
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="text-zinc-500"
          >
            <line x1="6" y1="6" x2="18" y2="18" /><line
              x1="18"
              y1="6"
              x2="6"
              y2="18"
            />
          </svg>
        {:else}
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="text-zinc-500"
          >
            <line x1="4" y1="7" x2="20" y2="7" /><line
              x1="4"
              y1="12"
              x2="20"
              y2="12"
            /><line x1="4" y1="17" x2="20" y2="17" />
          </svg>
        {/if}
      </button>
    </div>
  </div>

  <!-- Mobile dropdown -->
  {#if menuOpen}
    <nav
      id="mobile-menu"
      class="border-t border-zinc-200 bg-zinc-50 px-6 py-3 sm:hidden dark:border-zinc-800 dark:bg-zinc-950"
      transition:slide={{ duration: 200, axis: "y" }}
    >
      <div class="flex flex-col gap-1">
        {#each links as link (link.href)}
          <a
            href={link.href}
            class="rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
            onclick={() => (menuOpen = false)}
          >
            {link.label}
          </a>
        {/each}
      </div>
    </nav>
  {/if}
</header>
