<script lang="ts">
	let {
		value = $bindable(''),
		label = '',
		id = crypto.randomUUID(),
		min = '',
		max = '',
		disabled = false,
		error = ''
	}: {
		value?: string;
		label?: string;
		id?: string;
		min?: string;
		max?: string;
		disabled?: boolean;
		error?: string;
	} = $props();
</script>

<div class="flex flex-col gap-1">
	{#if label}<label for={id} class="label">{label}</label>{/if}
	<input
		type="datetime-local"
		{id}
		bind:value
		{min}
		{max}
		{disabled}
		aria-invalid={error ? 'true' : undefined}
		class="input-base {error ? 'input-error' : 'input-valid'}"
	/>
	{#if error}<p class="text-xs text-red-600 dark:text-red-400">{error}</p>{/if}
</div>
