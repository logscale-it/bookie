<script lang="ts">
  import { base } from "$app/paths";
</script>

<svelte:head>
  <title>Page not found — Bookie</title>
</svelte:head>

<div
  class="flex min-h-[70vh] flex-col items-center justify-center px-6 py-24 text-center"
>
  <img src={`${base}/favicon.svg`} alt="" class="h-16 w-16 rounded-2xl" />
  <p
    class="mt-8 text-sm font-semibold tracking-widest text-blue-600 uppercase dark:text-blue-400"
  >
    404
  </p>
  <h1 class="mt-2 text-3xl font-bold tracking-tight">
    Page not found / Seite nicht gefunden
  </h1>
  <p class="mt-3 max-w-md text-zinc-500 dark:text-zinc-400">
    The page you are looking for does not exist. / Die gesuchte Seite existiert
    nicht.
  </p>
  <a href={`${base}/`} class="btn-primary mt-10">
    Back to Bookie — Zurück zu Bookie
  </a>
  <div class="mt-6 flex gap-6 text-sm">
    <a
      href={`${base}/`}
      class="text-zinc-400 transition hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
    >
      English
    </a>
    <a
      href={`${base}/de/`}
      class="text-zinc-400 transition hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
    >
      Deutsch
    </a>
  </div>
</div>
