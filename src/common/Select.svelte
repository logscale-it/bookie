<script lang="ts">
	let {
		value = $bindable(''),
		label = '',
		options = [],
		placeholder = 'Select...',
		disabled = false,
		error = ''
	}: {
		value?: string;
		label?: string;
		options?: { value: string; label: string }[];
		placeholder?: string;
		disabled?: boolean;
		error?: string;
	} = $props();

	const id = crypto.randomUUID();
</script>

<div class="flex flex-col gap-1.5">
	{#if label}<label for={id} class="label">{label}</label>{/if}
	<select
		{id}
		bind:value
		{disabled}
		aria-invalid={error ? 'true' : undefined}
		class="input-base cursor-pointer pr-8 rounded-lg shadow-[0_1px_2px_rgb(24_24_27/0.04)] dark:bg-zinc-800/60 {error ? 'input-error' : 'input-valid border-zinc-900/10 hover:border-zinc-900/20 focus:border-accent-500 dark:border-white/10 dark:hover:border-white/20 dark:focus:border-accent-400'}"
	>
		{#if placeholder}<option value="" disabled>{placeholder}</option>{/if}
		{#each options as opt}
			<option value={opt.value}>{opt.label}</option>
		{/each}
	</select>
	{#if error}<p class="text-xs text-red-600 dark:text-red-400">{error}</p>{/if}
</div>
