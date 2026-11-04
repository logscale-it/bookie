<script lang="ts">
	// Loading placeholder for table bodies: `rows` shimmering lines whose
	// widths vary so it reads as content, not a progress bar.
	let { rows = 6, cols = 4 }: { rows?: number; cols?: number } = $props();
	const widths = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5'];
</script>

<div aria-busy="true" aria-live="polite" class="divide-y divide-zinc-100 dark:divide-zinc-700/60">
	{#each Array(rows) as _, r}
		<div class="grid items-center gap-4 px-4 py-3.5" style="grid-template-columns: repeat({cols}, minmax(0, 1fr)); opacity: {1 - r * 0.12}">
			{#each Array(cols) as _, c}
				<div class="skeleton h-3 {widths[(r + c) % widths.length]}"></div>
			{/each}
		</div>
	{/each}
</div>
