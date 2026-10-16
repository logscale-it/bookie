<script lang="ts">
  import { base } from "$app/paths";
</script>

<svelte:head>
  <title>Seite nicht gefunden — Bookie</title>
  <meta name="robots" content="noindex" />
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
  <h1 class="mt-2 text-3xl font-bold tracking-tight">Seite nicht gefunden</h1>
  <p class="mt-3 max-w-md text-zinc-500 dark:text-zinc-400">
    Die gesuchte Seite existiert nicht.
  </p>
  <a href={`${base}/de/`} class="btn-primary mt-10">Zurück zu Bookie</a>
</div>
