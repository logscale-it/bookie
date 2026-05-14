<script lang="ts">
	let {
		value = '',
		label = ''
	}: {
		value?: string;
		label?: string;
	} = $props();
</script>

<div class="flex flex-col gap-1">
	{#if label}<span class="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>{/if}
	<div class="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900/80 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100/80">
		{value || '\u00A0'}
	</div>
</div>
