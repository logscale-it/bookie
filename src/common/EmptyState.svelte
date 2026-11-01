<script lang="ts">
	// Empty list placeholder: thin-line icon, one sentence, optional CTA.
	// `icon` is an SVG path `d` (24x24 outline, drawn at stroke 1.25).
	let {
		icon = 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
		title,
		hint,
		actionLabel,
		actionHref,
		onaction
	}: {
		icon?: string;
		title: string;
		hint?: string;
		actionLabel?: string;
		actionHref?: string;
		onaction?: () => void;
	} = $props();
</script>

<div class="flex animate-pop flex-col items-center justify-center gap-3 px-6 py-14 text-center">
	<span class="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400 ring-1 ring-zinc-900/5 dark:bg-zinc-800 dark:text-zinc-500 dark:ring-white/10">
		<svg class="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.25"><path stroke-linecap="round" stroke-linejoin="round" d={icon} /></svg>
	</span>
	<div class="space-y-1">
		<p class="text-sm font-medium text-zinc-700 dark:text-zinc-200">{title}</p>
		{#if hint}<p class="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>{/if}
	</div>
	{#if actionLabel && actionHref}
		<a href={actionHref} class="btn-primary mt-1">{actionLabel}</a>
	{:else if actionLabel && onaction}
		<button type="button" class="btn-primary mt-1" onclick={onaction}>{actionLabel}</button>
	{/if}
</div>
