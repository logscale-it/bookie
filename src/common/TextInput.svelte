<script lang="ts">
	let {
		value = $bindable(''),
		label = '',
		placeholder = '',
		type = 'text',
		disabled = false,
		error = '',
		list = undefined
	}: {
		value?: string;
		label?: string;
		placeholder?: string;
		type?: string;
		disabled?: boolean;
		error?: string;
		list?: string;
	} = $props();

	const id = crypto.randomUUID();
</script>

<div class="flex flex-col gap-1">
	{#if label}<label for={id} class="label">{label}</label>{/if}
	<input
		{id}
		{type}
		bind:value
		{placeholder}
		{disabled}
		{list}
		aria-invalid={error ? 'true' : undefined}
		class="input-base {error ? 'input-error' : 'input-valid'}"
	/>
	{#if error}<p class="text-xs text-red-600 dark:text-red-400">{error}</p>{/if}
</div>
