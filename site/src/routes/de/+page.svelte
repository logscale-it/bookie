<script lang="ts">
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import FeatureCard from "$lib/components/FeatureCard.svelte";
  import DownloadSection from "$lib/components/DownloadSection.svelte";
  import { detectOs, type Os } from "$lib/os";
  import { CONTACT_EMAIL, LATEST_RELEASE_URL, SITE_URL } from "$lib/site";

  // Gleiches Muster wie der Kontakt-Button auf logscale-it.com: Das
  // Mail-Programm öffnet sich mit vorbereitetem Betreff und Textvorlage.
  const contactSubject = encodeURIComponent("Anfrage: Bookie Cloud");
  const contactBody = encodeURIComponent(
    "Hallo LogScale-Team,\n\nich interessiere mich für [Bookie Cloud / Dienstleistung].\n\n[Kurzbeschreibung der Anfrage]\n\nName: [Ihr Name]\nFirma: [Firma]\nTelefon (optional): [Telefonnummer]",
  );
  const contactHref = `mailto:${CONTACT_EMAIL}?subject=${contactSubject}&body=${contactBody}`;

  let os = $state<Os | null>(null);

  onMount(() => {
    os = detectOs();
  });

  const heroLabels: Record<Os, string> = {
    macos: "Für macOS herunterladen",
    windows: "Für Windows herunterladen",
    linux: "Für Linux herunterladen",
  };
</script>

<svelte:head>
  <title>Bookie — Lokale Buchhaltung &amp; Rechnungen für Freelancer</title>
  <meta
    name="description"
    content="Kostenlose Open-Source-Buchhaltung für Freelancer und kleine Unternehmen. Rechnungen nach deutschem Recht, Dashboard, Zeiterfassung. Offline-Alternative zu lexoffice und sevDesk für macOS, Windows und Linux."
  />
  <meta
    name="keywords"
    content="accounting, invoicing, small business, German law, Rechnungen, Buchhaltung, desktop app, local-first, open source, Tauri"
  />
  <link rel="canonical" href="{SITE_URL}/de/" />
  <link rel="alternate" hreflang="en" href="{SITE_URL}/" />
  <link rel="alternate" hreflang="de" href="{SITE_URL}/de/" />
  <link rel="alternate" hreflang="x-default" href="{SITE_URL}/" />

  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="{SITE_URL}/de/" />
  <meta
    property="og:title"
    content="Bookie — Lokale Buchhaltung &amp; Rechnungen für Freelancer"
  />
  <meta
    property="og:description"
    content="Kostenlose Open-Source-Desktop-App. Rechnungen nach deutschem Recht, Dashboard und Zeiterfassung. Deine Daten bleiben auf deinem Gerät."
  />
  <meta property="og:image" content="{SITE_URL}/social-preview.png" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Bookie — Lokale Buchhaltung" />
  <meta
    name="twitter:description"
    content="Kostenlose Open-Source-Buchhaltung. Offline. macOS, Windows, Linux."
  />
  <meta name="twitter:image" content="{SITE_URL}/social-preview.png" />

  <!-- Structured Data -->
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "name": "Bookie",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "macOS, Windows, Linux",
      "description": "Lokale Desktop-Buchhaltung für kleine Unternehmen nach deutschem Recht.",
      "url": "https://logscale-it.github.io/bookie/de/",
      "downloadUrl": "https://github.com/logscale-it/bookie/releases/latest",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "EUR" },
      "author": { "@type": "Organization", "name": "logscale-it" }
    }
  </script>
</svelte:head>

<!-- Hero -->
<section
  class="border-b border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
>
  <div class="mx-auto max-w-5xl px-6 pb-20 pt-20 text-center">
    <svg
      class="mx-auto mb-8 h-[4.5rem] w-[4.5rem] rounded-2xl"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <defs
        ><linearGradient id="hero-logo-g" x1="0%" y1="0%" x2="100%" y2="100%"
          ><stop offset="0%" stop-color="#34d399" /><stop
            offset="100%"
            stop-color="#10b981"
          /></linearGradient
        ></defs
      >
      <rect
        x="16"
        y="16"
        width="224"
        height="224"
        rx="48"
        fill="url(#hero-logo-g)"
      />
      <path
        d="M110 72L138 72C166 72 178 88 178 106C178 122 166 134 150 138C170 142 184 156 184 178C184 202 166 216 138 216L110 216ZM138 100C152 100 158 106 158 116C158 126 152 132 138 132L126 132L126 100ZM138 156C156 156 162 164 162 176C162 188 154 196 138 196L126 196L126 156Z"
        fill="white"
      />
    </svg>
    <h1
      class="mx-auto mb-4 max-w-xl text-4xl font-bold leading-tight tracking-tight sm:text-[2.5rem]"
    >
      Lokale Buchhaltung für Freelancer und kleine Unternehmen
    </h1>
    <p
      class="mx-auto mb-10 max-w-lg text-lg leading-relaxed text-zinc-500 dark:text-zinc-400"
    >
      Kostenlose Open-Source-Desktop-App für Rechnungen nach deutschem Recht,
      Zeiterfassung und Dashboard. Keine Cloud, kein Abo. Deine Daten bleiben
      auf deinem Gerät.
    </p>
    <div class="flex flex-col items-center gap-4">
      <a href={LATEST_RELEASE_URL} class="btn-primary">
        <svg
          viewBox="0 0 24 24"
          class="h-5 w-5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline
            points="7 10 12 15 17 10"
          /><line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {os ? heroLabels[os] : "Herunterladen"}
      </a>
      <a
        href={`${base}/de/#download`}
        class="text-[0.8125rem] text-zinc-400 transition hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        Alle Plattformen &rarr;
      </a>
    </div>
    <img
      class="mx-auto mt-12 block w-full max-w-[880px] rounded-xl border border-zinc-200 shadow-[0_20px_50px_rgba(0,0,0,0.12)] dark:border-zinc-800"
      src={`${base}/screenshots/dashboard-profit-loss.jpg`}
      alt="Bookie Dashboard mit Gewinn und Verlust"
      width="1600"
      height="1000"
    />
  </div>
</section>

<!-- Features -->
<section id="features" class="section">
  <h2 class="section-title">Alles, was du brauchst</h2>
  <p class="section-subtitle">
    Einfache Werkzeuge für deine Finanzen — nicht mehr, nicht weniger.
  </p>
  <div class="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
    <FeatureCard
      title="Rechnungen"
      text="Rechtskonforme Rechnungen mit automatischer Nummerierung, PDF-Export und Statusverfolgung."
    >
      {#snippet icon()}<path
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Eingehende Rechnungen"
      text="Erhaltene Rechnungen hochladen und ordnen. Alle Ausgaben an einem Ort."
    >
      {#snippet icon()}<path
          d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Finanz-Dashboard"
      text="Gewinn, Verlust und Umsatz auf einen Blick, mit klaren Diagrammen."
    >
      {#snippet icon()}<path
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Zeiterfassung"
      text="Stunden pro Projekt und Kunde erfassen und direkt in Rechnungen überführen."
    >
      {#snippet icon()}<path
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Automatische Backups"
      text="Optionale S3-Anbindung für automatische Backups."
    >
      {#snippet icon()}<path
          d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Datenschutz zuerst"
      text="Komplett lokal — deine Finanzdaten verlassen dein Gerät nie. Kein Konto, kein Tracking, kein Abo."
    >
      {#snippet icon()}<path
          d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />{/snippet}
    </FeatureCard>
  </div>
</section>

<!-- Preise -->
<section id="preise" class="border-t border-zinc-200 dark:border-zinc-800">
  <div class="section">
    <h2 class="section-title">Preise</h2>
    <p class="section-subtitle">
      Bookie Local ist für immer kostenlos. Eine gemanagte Cloud-Version kommt
      bald.
    </p>

    <!-- TODO(pricing): den Platzhalter-Preis auf der Bookie-Cloud-Karte durch
         den finalen Preis pro Sitzplatz ersetzen, sobald dieser feststeht. -->
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

    <!-- Kontakt -->
    <div class="mt-16 text-center">
      <h3 class="text-xl font-bold tracking-tight">Fragen zu Bookie Cloud?</h3>
      <p class="mx-auto mt-3 max-w-xl text-zinc-500 dark:text-zinc-400">
        Schreib uns eine E-Mail — dein Mail-Programm öffnet sich mit einer
        vorbereiteten Vorlage. Ersetze einfach die Platzhalter in eckigen
        Klammern.
      </p>
      <a href={contactHref} class="btn-primary mt-6">E-Mail schreiben</a>
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
  </div>
</section>

<DownloadSection
  title="Bookie herunterladen"
  subtitle="Für alle gängigen Systeme. Kostenlos und Open Source."
  button="Herunterladen"
  formats={{
    macos: "DMG-Installer",
    windows: "MSI-Installer",
    linux: "AppImage & .deb",
  }}
  note="Die macOS-Version läuft nur auf Apple Silicon. Bookie ist noch nicht code-signiert, dein System warnt deshalb beim ersten Start."
  noteLink="So öffnest du es"
/>
