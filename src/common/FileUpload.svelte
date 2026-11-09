<script lang="ts">
	import { t } from '$lib/i18n';
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
			'group flex min-h-[88px] w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-4 text-center text-sm transition duration-200 ease-spring focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-500/15 dark:text-zinc-100',
			dragging
				? 'scale-[1.01] border-accent-500 bg-accent-50 dark:border-accent-400 dark:bg-accent-900/20'
				: 'border-zinc-300 bg-zinc-50/60 dark:border-zinc-600 dark:bg-zinc-800/40',
			disabled
				? 'cursor-not-allowed opacity-50'
				: 'text-zinc-900 hover:border-accent-400 hover:bg-accent-50/50 dark:hover:border-accent-500 dark:hover:bg-accent-900/10'
		].join(' ')
	);
</script>

<div class="flex flex-col gap-1.5">
	{#if label}<label for={id} class="label">{label}</label>{/if}
	<button
		type="button"
		ondragover={handleDragOver}
		ondragleave={handleDragLeave}
		ondrop={handleDrop}
		onclick={handleClick}
		class={buttonClass}
	>
		<input {id} bind:this={fileInput} type="file" {accept} {multiple} {disabled} onchange={handleChange} hidden />
		<svg
			class="h-6 w-6 transition duration-200 ease-spring {dragging
				? '-translate-y-0.5 text-accent-600 dark:text-accent-400'
				: 'text-zinc-400 group-hover:-translate-y-0.5 group-hover:text-accent-500'}"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="1.5"
			aria-hidden="true"
			><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg
		>
		{#if fileNames}
			<span class="break-all text-xs font-medium text-zinc-700 dark:text-zinc-200">{fileNames}</span>
		{:else}
			<span class="text-xs text-zinc-500 dark:text-zinc-400">{t('fileUpload.dropHint')}</span>
		{/if}
	</button>
</div>
