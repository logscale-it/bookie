<script lang="ts">
	let {
		id = crypto.randomUUID(),
		value = $bindable(''),
		label = '',
		min = '',
		max = '',
		disabled = false,
		error = ''
	}: {
		id?: string;
		value?: string;
		label?: string;
		min?: string;
		max?: string;
		disabled?: boolean;
		error?: string;
	} = $props();
</script>

<div class="flex flex-col gap-1.5">
	{#if label}<label for={id} class="label">{label}</label>{/if}
	<input
		{id}
		type="date"
		bind:value
		{min}
		{max}
		{disabled}
		aria-invalid={error ? 'true' : undefined}
		class="input-base rounded-lg shadow-[0_1px_2px_rgb(24_24_27/0.04)] dark:bg-zinc-800/60 {error ? 'input-error' : 'input-valid border-zinc-900/10 hover:border-zinc-900/20 focus:border-accent-500 dark:border-white/10 dark:hover:border-white/20 dark:focus:border-accent-400'}"
	/>
	{#if error}<p class="text-xs text-red-600 dark:text-red-400">{error}</p>{/if}
</div>
