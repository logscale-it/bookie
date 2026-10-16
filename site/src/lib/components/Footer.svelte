<script lang="ts">
  import { base } from "$app/paths";
  import {
    ORG_URL,
    REPO_URL,
    RELEASES_URL,
    LICENSE_URL,
    DOCS_URL,
  } from "$lib/site";

  let { isDe }: { isDe: boolean } = $props();

  const pricingHref = $derived(
    isDe ? `${base}/de/preise/` : `${base}/pricing/`,
  );
</script>

<footer
  class="border-t border-zinc-200 bg-zinc-100 py-8 text-center dark:border-zinc-800 dark:bg-zinc-900"
>
  <p class="text-sm text-zinc-400 dark:text-zinc-500">
    {isDe ? "ein" : "a"} <strong>logscale-it</strong>
    {isDe ? "Produkt" : "product"} &middot;
    <a
      href={ORG_URL}
      target="_blank"
      rel="noopener"
      class="text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-50"
    >
      {isDe
        ? "individuelle Softwareentwicklung"
        : "custom software development"}
    </a>
  </p>
  <nav class="mt-3 flex flex-wrap justify-center gap-6">
    <a
      href={pricingHref}
      class="text-[0.8125rem] text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-50"
    >
      {isDe ? "Preise" : "Pricing"}
    </a>
    <a
      href={`${base}/de/impressum/`}
      class="text-[0.8125rem] text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-50"
    >
      Impressum
    </a>
    <a
      href={`${base}/de/datenschutz/`}
      class="text-[0.8125rem] text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-50"
    >
      Datenschutz
    </a>
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noopener"
      class="text-[0.8125rem] text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-50"
    >
      {isDe ? "Dokumentation" : "Docs"}
    </a>
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener"
      class="text-[0.8125rem] text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-50"
    >
      GitHub
    </a>
    <a
      href={RELEASES_URL}
      target="_blank"
      rel="noopener"
      class="text-[0.8125rem] text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-50"
    >
      Releases
    </a>
    <a
      href={LICENSE_URL}
      target="_blank"
      rel="noopener"
      class="text-[0.8125rem] text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-50"
    >
      {isDe ? "Lizenz" : "License"}
    </a>
  </nav>
</footer>
