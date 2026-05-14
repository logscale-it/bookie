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

<div class="flex flex-col gap-1">
	{#if label}<label for={id} class="label">{label}</label>{/if}
	<select
		{id}
		bind:value
		{disabled}
		aria-invalid={error ? 'true' : undefined}
		class="input-base cursor-pointer pr-8 {error ? 'input-error' : 'input-valid'}"
	>
		{#if placeholder}<option value="" disabled>{placeholder}</option>{/if}
		{#each options as opt}
			<option value={opt.value}>{opt.label}</option>
		{/each}
	</select>
	{#if error}<p class="text-xs text-red-600 dark:text-red-400">{error}</p>{/if}
</div>
