<script lang="ts">
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import FeatureCard from "$lib/components/FeatureCard.svelte";
  import DownloadSection from "$lib/components/DownloadSection.svelte";
  import { detectOs, type Os } from "$lib/os";
  import { LATEST_RELEASE_URL, SITE_URL } from "$lib/site";

  let os = $state<Os | null>(null);

  onMount(() => {
    os = detectOs();
  });

  const heroLabels: Record<Os, string> = {
    macos: "Download for macOS",
    windows: "Download for Windows",
    linux: "Download for Linux",
  };
</script>

<svelte:head>
  <title>Bookie — Local-First Accounting for Small Businesses</title>
  <meta
    name="description"
    content="Free, open-source desktop accounting app for small businesses. German law compliant invoicing, dashboards, time tracking. Runs on macOS, Windows, and Linux."
  />
  <meta
    name="keywords"
    content="accounting, invoicing, small business, German law, Rechnungen, Buchhaltung, desktop app, local-first, open source, Tauri"
  />
  <link rel="canonical" href="{SITE_URL}/" />
  <link rel="alternate" hreflang="en" href="{SITE_URL}/" />
  <link rel="alternate" hreflang="de" href="{SITE_URL}/de/" />
  <link rel="alternate" hreflang="x-default" href="{SITE_URL}/" />

  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="{SITE_URL}/" />
  <meta
    property="og:title"
    content="Bookie — Local-First Accounting for Small Businesses"
  />
  <meta
    property="og:description"
    content="Free, open-source desktop app. German law compliant invoicing, dashboards, and time tracking. Your data stays on your device."
  />
  <meta property="og:image" content="{SITE_URL}/social-preview.png" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Bookie — Local-First Accounting" />
  <meta
    name="twitter:description"
    content="Free, open-source desktop accounting app. German law compliant. macOS, Windows, Linux."
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
      "description": "Local-first desktop accounting app for small businesses, compliant with German law.",
      "url": "https://logscale-it.github.io/bookie/",
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
      Local-first accounting for small businesses
    </h1>
    <p
      class="mx-auto mb-10 max-w-lg text-lg leading-relaxed text-zinc-500 dark:text-zinc-400"
    >
      Free, open-source desktop app. German law compliant invoicing, time
      tracking, and financial dashboards. Your data stays on your device.
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
        {os ? heroLabels[os] : "Download"}
      </a>
      <a
        href={`${base}/#download`}
        class="text-[0.8125rem] text-zinc-400 transition hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        All platforms &rarr;
      </a>
    </div>
    <img
      class="mx-auto mt-12 block w-full max-w-[880px] rounded-xl border border-zinc-200 shadow-[0_20px_50px_rgba(0,0,0,0.12)] dark:border-zinc-800"
      src={`${base}/screenshots/dashboard-profit-loss.jpg`}
      alt="Bookie dashboard with profit and loss"
      width="1600"
      height="1000"
    />
  </div>
</section>

<!-- Features -->
<section id="features" class="section">
  <h2 class="section-title">Everything you need</h2>
  <p class="section-subtitle">
    Simple tools to run your business finances — nothing more, nothing less.
  </p>
  <div class="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
    <FeatureCard
      title="Invoice Management"
      text="Create and manage law-compliant invoices with automatic numbering, PDF export, and status tracking."
    >
      {#snippet icon()}<path
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Incoming Invoices"
      text="Upload and organize received invoices. Keep all your expenses in one place for easy bookkeeping."
    >
      {#snippet icon()}<path
          d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Financial Dashboard"
      text="Track profit, loss, and revenue at a glance with clear visualizations and real-time calculations."
    >
      {#snippet icon()}<path
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Time Tracking"
      text="Log hours by project and client. Generate reports and convert tracked time directly into invoices."
    >
      {#snippet icon()}<path
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Automated Backups"
      text="Optional S3 bucket support for automated backups and data resilience. Your data is always safe."
    >
      {#snippet icon()}<path
          d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
        />{/snippet}
    </FeatureCard>

    <FeatureCard
      title="Privacy First"
      text="Fully local — your financial data never leaves your device. No cloud accounts, no tracking, no subscriptions."
    >
      {#snippet icon()}<path
          d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />{/snippet}
    </FeatureCard>
  </div>
</section>

<!-- Pricing teaser -->
<section class="border-t border-zinc-200 dark:border-zinc-800">
  <div class="section text-center">
    <h2 class="section-title">Bookie is free</h2>
    <p class="mx-auto max-w-xl text-zinc-500 dark:text-zinc-400">
      Bookie Local is free, open source, and stays that way. A managed cloud
      version is coming soon.
    </p>
    <a
      href={`${base}/pricing/`}
      class="btn-secondary mt-8 inline-flex w-auto px-6"
    >
      See pricing
    </a>
  </div>
</section>

<DownloadSection
  title="Download Bookie"
  subtitle="Available for all major platforms. Free and open source."
  button="Download"
  formats={{
    macos: "DMG installer",
    windows: "MSI installer",
    linux: "AppImage & .deb",
  }}
  note="macOS build is Apple Silicon only. Bookie is not yet code-signed, so your OS may warn you on first start."
  noteLink="How to open it"
/>
