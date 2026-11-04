<script lang="ts">
	let {
		value = '',
		label = ''
	}: {
		value?: string;
		label?: string;
	} = $props();
</script>

<div class="flex flex-col gap-1.5">
	{#if label}<span class="label">{label}</span>{/if}
	<div class="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-800 ring-1 ring-inset ring-zinc-900/5 dark:bg-zinc-800/60 dark:text-zinc-200 dark:ring-white/10">
		{value || ' '}
	</div>
</div>
