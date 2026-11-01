<script lang="ts">
	// Settings card header: accent eyebrow, title, optional helper text.
	let { eyebrow, title, desc }: { eyebrow: string; title: string; desc?: string } = $props();
</script>

<div>
	<p class="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-600 dark:text-accent-400">{eyebrow}</p>
	<h2 class="mt-1 text-base font-semibold tracking-tight">{title}</h2>
	{#if desc}<p class="mt-1 max-w-prose text-sm text-zinc-500 dark:text-zinc-400">{desc}</p>{/if}
</div>
