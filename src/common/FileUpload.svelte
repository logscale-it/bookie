<script lang="ts">
	let {
		files = $bindable<FileList | null>(null),
		label = '',
		accept = '',
		multiple = false,
		disabled = false,
		id = crypto.randomUUID()
	}: {
		files?: FileList | null;
		label?: string;
		accept?: string;
		multiple?: boolean;
		disabled?: boolean;
		id?: string;
	} = $props();

	let dragging = $state(false);
	let fileInput: HTMLInputElement;

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		if (!disabled) dragging = true;
	}

	function handleDragLeave() {
		dragging = false;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (disabled || !e.dataTransfer) return;
		files = e.dataTransfer.files;
	}

	function handleClick() {
		if (!disabled) fileInput.click();
	}

	function handleChange() {
		files = fileInput.files;
	}

	let fileNames = $derived.by(() => {
		if (!files || files.length === 0) return '';
		return Array.from(files)
			.map((file) => file?.name ?? '')
			.filter(Boolean)
			.join(', ');
	});

	let buttonClass = $derived(
		[
			'flex min-h-[72px] w-full items-center justify-center rounded-md border border-dashed px-3 py-3 text-center text-sm transition dark:text-zinc-100',
			dragging ? 'border-blue-500 bg-blue-500/5' : 'border-zinc-300 bg-white dark:bg-zinc-700',
			disabled ? 'cursor-not-allowed opacity-50' : 'text-zinc-900 hover:border-blue-500'
		].join(' ')
	);
</script>

<div class="flex flex-col gap-1">
	{#if label}<label for={id} class="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</label>{/if}
	<button
		type="button"
		ondragover={handleDragOver}
		ondragleave={handleDragLeave}
		ondrop={handleDrop}
		onclick={handleClick}
		class={buttonClass}
	>
		<input {id} bind:this={fileInput} type="file" {accept} {multiple} {disabled} onchange={handleChange} hidden />
		{#if fileNames}
			<span class="break-all text-xs">{fileNames}</span>
		{:else}
			<span class="text-xs text-zinc-500 dark:text-zinc-400">Drop files here or click to browse</span>
		{/if}
	</button>
</div>
