<script lang="ts">
  import { base } from "$app/paths";
</script>

<svelte:head>
  <title>Page not found — Bookie</title>
</svelte:head>

<div class="section text-center">
  <h1 class="text-2xl font-bold tracking-tight">
    Page not found / Seite nicht gefunden
  </h1>
  <p class="mx-auto mt-3 max-w-md text-zinc-500 dark:text-zinc-400">
    The page you are looking for does not exist.
  </p>
  <div class="mt-8 flex justify-center gap-4">
    <a href={`${base}/`} class="btn-primary">Bookie</a>
    <a href={`${base}/de/`} class="btn-secondary w-auto px-6">Deutsch</a>
  </div>
</div>
