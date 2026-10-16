<script lang="ts">
  import { LATEST_RELEASE_URL, REPO_URL, SITE_URL } from "$lib/site";
</script>

<svelte:head>
  <title>Pricing — Bookie</title>
  <meta
    name="description"
    content="Bookie Local is free, open source, and stays that way. A managed cloud version is planned — pricing per seat will be announced here."
  />
  <link rel="canonical" href="{SITE_URL}/pricing/" />
  <link rel="alternate" hreflang="en" href="{SITE_URL}/pricing/" />
  <link rel="alternate" hreflang="de" href="{SITE_URL}/de/preise/" />
  <link rel="alternate" hreflang="x-default" href="{SITE_URL}/" />
</svelte:head>

<section
  class="border-b border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
>
  <div class="section pb-14 text-center">
    <h1 class="text-[2.5rem] font-bold tracking-tight">Pricing</h1>
    <p class="mx-auto mt-3 max-w-xl text-lg text-zinc-500 dark:text-zinc-400">
      Bookie Local is free, forever. A managed cloud version is in the works.
    </p>
  </div>
</section>

<!-- TODO(pricing): replace the placeholder price on the Bookie Cloud card with the
     final per-seat price once it has been decided. -->
<section class="section">
  <div class="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
    <!-- Bookie Local -->
    <div class="card p-8">
      <h2 class="text-lg font-semibold">Bookie Local</h2>
      <p class="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Free, open source
      </p>
      <p class="mb-1 text-4xl font-bold tracking-tight">€0</p>
      <p class="mb-8 text-xs text-zinc-400 dark:text-zinc-500">
        forever — no account, no subscription
      </p>
      <ul class="mb-8 space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          German law compliant invoicing (DE, AT, CH, FR, NL, US)
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Dashboards for revenue and profit/loss
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Time tracking and timesheets
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Backups, with optional S3 sync
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Your data never leaves your device
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          All app updates included
        </li>
      </ul>
      <a
        href={LATEST_RELEASE_URL}
        target="_blank"
        rel="noopener"
        class="btn-primary w-full justify-center"
      >
        Download
      </a>
    </div>

    <!-- Bookie Cloud (planned) -->
    <div class="card border-blue-600 p-8 shadow-[0_0_0_1px_#2563eb]">
      <div class="mb-1 flex items-center gap-3">
        <h2 class="text-lg font-semibold">Bookie Cloud</h2>
        <span
          class="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300"
        >
          Planned
        </span>
      </div>
      <p class="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Managed cloud version
      </p>
      <!-- TODO(pricing): final price per seat is not yet set -->
      <p class="mb-1 text-4xl font-bold tracking-tight">€?</p>
      <p class="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
        per seat / month
      </p>
      <p class="mb-8 text-xs text-zinc-400 dark:text-zinc-500">
        Final pricing not yet set
      </p>
      <ul class="mb-8 space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Everything in Bookie Local
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Managed cloud backups — no own S3 bucket needed
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Multi-device sync
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Shared company data for teams
        </li>
        <li class="flex gap-2.5">
          <svg
            viewBox="0 0 24 24"
            class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg
          >
          Priority support
        </li>
      </ul>
      <a href={REPO_URL} target="_blank" rel="noopener" class="btn-secondary">
        Get notified
      </a>
    </div>
  </div>
  <p
    class="mx-auto mt-10 max-w-2xl text-center text-sm text-zinc-500 dark:text-zinc-400"
  >
    Pricing for Bookie Cloud is not final — this page will be updated as soon as
    the price per seat is decided. Until then, Bookie Local is and stays free.
  </p>
</section>
