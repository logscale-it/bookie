<script lang="ts">
  import { LATEST_RELEASE_URL, REPO_URL, SITE_URL } from "$lib/site";
</script>

<svelte:head>
  <title>Preise — Bookie</title>
  <meta
    name="description"
    content="Bookie Local ist kostenlos, Open Source, und bleibt es. Eine gemanagte Cloud-Version ist geplant — der Preis pro Sitzplatz wird hier angekündigt."
  />
  <link rel="canonical" href="{SITE_URL}/de/preise/" />
  <link rel="alternate" hreflang="en" href="{SITE_URL}/pricing/" />
  <link rel="alternate" hreflang="de" href="{SITE_URL}/de/preise/" />
  <link rel="alternate" hreflang="x-default" href="{SITE_URL}/" />
</svelte:head>

<section
  class="border-b border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
>
  <div class="section pb-14 text-center">
    <h1 class="text-[2.5rem] font-bold tracking-tight">Preise</h1>
    <p class="mx-auto mt-3 max-w-xl text-lg text-zinc-500 dark:text-zinc-400">
      Bookie Local ist für immer kostenlos. Eine gemanagte Cloud-Version ist in
      Arbeit.
    </p>
  </div>
</section>

<!-- TODO(pricing): den Platzhalter-Preis auf der Bookie-Cloud-Karte durch den
     finalen Preis pro Sitzplatz ersetzen, sobald dieser feststeht. -->
<section class="section">
  <div class="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
    <!-- Bookie Local -->
    <div class="card p-8">
      <h2 class="text-lg font-semibold">Bookie Local</h2>
      <p class="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Kostenlos, Open Source
      </p>
      <p class="mb-1 text-4xl font-bold tracking-tight">€0</p>
      <p class="mb-8 text-xs text-zinc-400 dark:text-zinc-500">
        für immer — kein Konto, kein Abo
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
          Rechtskonforme Rechnungen (DE, AT, CH, FR, NL, US)
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
          Dashboard für Umsatz und Gewinn/Verlust
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
          Zeiterfassung und Stundenzettel
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
          Backups, optional mit S3-Sync
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
          Deine Daten verlassen dein Gerät nie
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
          Alle App-Updates inklusive
        </li>
      </ul>
      <a
        href={LATEST_RELEASE_URL}
        target="_blank"
        rel="noopener"
        class="btn-primary w-full justify-center"
      >
        Herunterladen
      </a>
    </div>

    <!-- Bookie Cloud (geplant) -->
    <div class="card border-blue-600 p-8 shadow-[0_0_0_1px_#2563eb]">
      <div class="mb-1 flex items-center gap-3">
        <h2 class="text-lg font-semibold">Bookie Cloud</h2>
        <span
          class="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300"
        >
          Geplant
        </span>
      </div>
      <p class="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Gemanagte Cloud-Version
      </p>
      <!-- TODO(pricing): finaler Preis pro Sitzplatz steht noch nicht fest -->
      <p class="mb-1 text-4xl font-bold tracking-tight">€?</p>
      <p class="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
        pro Sitzplatz / Monat
      </p>
      <p class="mb-8 text-xs text-zinc-400 dark:text-zinc-500">
        Endpreis noch nicht festgelegt
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
          Alles aus Bookie Local
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
          Gemanagte Cloud-Backups — kein eigenes S3-Bucket nötig
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
          Synchronisierung über mehrere Geräte
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
          Gemeinsame Firmendaten für Teams
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
          Prioritäts-Support
        </li>
      </ul>
      <a href={REPO_URL} target="_blank" rel="noopener" class="btn-secondary">
        Benachrichtigt werden
      </a>
    </div>
  </div>
  <p
    class="mx-auto mt-10 max-w-2xl text-center text-sm text-zinc-500 dark:text-zinc-400"
  >
    Die Preise für Bookie Cloud sind noch nicht final — diese Seite wird
    aktualisiert, sobald der Preis pro Sitzplatz feststeht. Bis dahin ist und
    bleibt Bookie Local kostenlos.
  </p>
</section>
