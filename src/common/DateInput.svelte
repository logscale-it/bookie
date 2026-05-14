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

<div class="flex flex-col gap-1">
	{#if label}<label for={id} class="label">{label}</label>{/if}
	<input
		{id}
		type="date"
		bind:value
		{min}
		{max}
		{disabled}
		aria-invalid={error ? 'true' : undefined}
		class="input-base {error ? 'input-error' : 'input-valid'}"
	/>
	{#if error}<p class="text-xs text-red-600 dark:text-red-400">{error}</p>{/if}
</div>
