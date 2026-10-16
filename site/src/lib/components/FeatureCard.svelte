<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    text,
    icon,
  }: {
    title: string;
    text: string;
    /** SVG path(s) rendered inside a stroke icon (24x24 viewBox). */
    icon: Snippet;
  } = $props();
</script>

<div
  class="card p-7 transition hover:border-zinc-400 dark:hover:border-zinc-600"
>
  <div
    class="mb-4 flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400"
  >
    <svg
      viewBox="0 0 24 24"
      class="h-5 w-5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {@render icon()}
    </svg>
  </div>
  <h3 class="mb-1.5 text-[0.9375rem] font-semibold">{title}</h3>
  <p class="text-[0.8125rem] leading-relaxed text-zinc-500 dark:text-zinc-400">
    {text}
  </p>
</div>
