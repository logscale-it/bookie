<script lang="ts">
  import { CONTACT_EMAIL, LATEST_RELEASE_URL, SITE_URL } from "$lib/site";

  // Gleiches Muster wie der Kontakt-Button auf logscale-it.com: Das
  // Mail-Programm öffnet sich mit vorbereitetem Betreff und Textvorlage.
  const contactSubject = encodeURIComponent("Anfrage: Bookie Cloud");
  const contactBody = encodeURIComponent(
    "Hallo LogScale-Team,\n\nich interessiere mich für [Bookie Cloud / Dienstleistung].\n\n[Kurzbeschreibung der Anfrage]\n\nName: [Ihr Name]\nFirma: [Firma]\nTelefon (optional): [Telefonnummer]",
  );
  const contactHref = `mailto:${CONTACT_EMAIL}?subject=${contactSubject}&body=${contactBody}`;
</script>

<svelte:head>
  <title>Preise — Bookie</title>
  <meta
    name="description"
    content="Bookie Local ist kostenlos, Open Source, und bleibt es. Eine gemanagte Cloud-Version kommt bald — der Preis pro Sitzplatz wird hier angekündigt."
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
      Bookie Local ist für immer kostenlos. Eine gemanagte Cloud-Version kommt
      bald.
    </p>
  </div>
</section>

<!-- TODO(pricing): den Platzhalter-Preis auf der Bookie-Cloud-Karte durch den
     finalen Preis pro Sitzplatz ersetzen, sobald dieser feststeht. -->
<section class="section">
  <div class="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
    <!-- Bookie Local -->
    <div class="card flex flex-col p-8">
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
        class="btn-primary mt-auto w-full justify-center"
      >
        Herunterladen
      </a>
    </div>

    <!-- Bookie Cloud (bald verfügbar) -->
    <div
      class="card flex flex-col border-blue-600 p-8 shadow-[0_0_0_1px_#2563eb]"
    >
      <div class="mb-1 flex items-center gap-3">
        <h2 class="text-lg font-semibold">Bookie Cloud</h2>
        <span
          class="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300"
        >
          Bald verfügbar
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
      <a
        href={contactHref}
        class="btn-secondary mt-auto rounded-lg px-8 py-3 text-[0.9375rem] font-semibold"
      >
        Kontakt aufnehmen
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

<!-- Kontakt -->
<section class="border-t border-zinc-200 dark:border-zinc-800">
  <div class="section text-center">
    <h2 class="section-title">Fragen zu Bookie Cloud?</h2>
    <p class="mx-auto max-w-xl text-zinc-500 dark:text-zinc-400">
      Schreib uns eine E-Mail — dein Mail-Programm öffnet sich mit einer
      vorbereiteten Vorlage. Ersetze einfach die Platzhalter in eckigen
      Klammern.
    </p>
    <a href={contactHref} class="btn-primary mt-8">E-Mail schreiben</a>
    <p class="mx-auto mt-6 max-w-xl text-sm text-zinc-400 dark:text-zinc-500">
      oder direkt an
      <a
        href={`mailto:${CONTACT_EMAIL}`}
        class="text-blue-600 dark:text-blue-400"
      >
        {CONTACT_EMAIL}
      </a>
    </p>
  </div>
</section>
