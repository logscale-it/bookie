<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import Header from "$lib/components/Header.svelte";
  import Footer from "$lib/components/Footer.svelte";
  import "../app.css";

  let { children } = $props();

  const isDe = $derived(
    page.url.pathname.startsWith(`${base}/de/`) ||
      page.url.pathname === `${base}/de`,
  );
</script>

<Header {isDe} />

<main>
  {@render children()}
</main>

<Footer {isDe} />
