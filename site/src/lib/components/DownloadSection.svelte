<script lang="ts">
  import { onMount } from "svelte";
  import { LATEST_RELEASE_URL, REPO_URL } from "$lib/site";
  import { detectOs, type Os } from "$lib/os";

  let {
    title,
    subtitle,
    button,
    formats,
    note,
    noteLink,
  }: {
    title: string;
    subtitle: string;
    button: string;
    formats: Record<Os, string>;
    note: string;
    noteLink: string;
  } = $props();

  let os = $state<Os | null>(null);

  onMount(() => {
    os = detectOs();
  });

  const cards: { os: Os; name: string; icon: string }[] = [
    {
      os: "macos",
      name: "macOS",
      icon: "M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z",
    },
    {
      os: "windows",
      name: "Windows",
      icon: "M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801",
    },
    {
      os: "linux",
      name: "Linux",
      icon: "M12 2C9.8 2 8 4.5 8 7.5c0 1.5.4 2.9 1.1 4C7.2 12.3 6 13.6 6 15.5c0 .8.2 1.5.5 2.1-.8.4-1.5 1-1.5 1.9 0 1.4 2 2.5 7 2.5s7-1.1 7-2.5c0-.9-.7-1.5-1.5-1.9.3-.6.5-1.3.5-2.1 0-1.9-1.2-3.2-3.1-4 .7-1.1 1.1-2.5 1.1-4C16 4.5 14.2 2 12 2zm-1.5 5c0-.6.3-1 .7-1s.7.4.7 1-.3 1-.7 1-.7-.4-.7-1zm2.1 0c0-.6.3-1 .7-1s.7.4.7 1-.3 1-.7 1-.7-.4-.7-1zM12 10.5c-.5 0-.9-.2-1.2-.4.3-.1.5-.1.6-.1h1.2c.1 0 .3 0 .6.1-.3.2-.7.4-1.2.4z",
    },
  ];
</script>

<section
  id="download"
  class="border-y border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
>
  <div class="section">
    <h2 class="section-title">{title}</h2>
    <p class="section-subtitle">{subtitle}</p>
    <div class="grid gap-5 md:grid-cols-3">
      {#each cards as card (card.os)}
        <div
          class="card p-8 text-center"
          class:border-blue-600={os === card.os}
          class:shadow-[0_0_0_1px_#2563eb]={os === card.os}
        >
          <svg
            viewBox="0 0 24 24"
            class="mx-auto mb-4 h-10 w-10 fill-zinc-500 dark:fill-zinc-400"
            aria-hidden="true"
          >
            <path d={card.icon} />
          </svg>
          <h3 class="mb-1 text-base font-semibold">{card.name}</h3>
          <p class="mb-5 text-xs text-zinc-400 dark:text-zinc-500">
            {formats[card.os]}
          </p>
          <a
            href={LATEST_RELEASE_URL}
            target="_blank"
            rel="noopener"
            class:btn-primary={os === card.os}
            class:btn-secondary={os !== card.os}
          >
            {button}
          </a>
        </div>
      {/each}
    </div>
    <p
      class="mx-auto mt-8 max-w-xl text-center text-sm text-zinc-500 dark:text-zinc-400"
    >
      {note}
      <a
        href={`${REPO_URL}#unknown-publisher--cant-be-opened-warnings`}
        target="_blank"
        rel="noopener"
        class="text-blue-600 dark:text-blue-400"
      >
        {noteLink}
      </a>
    </p>
  </div>
</section>
