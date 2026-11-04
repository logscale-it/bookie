<script lang="ts">
	// Create form in a modal. The page owns the trigger (header button / `n`)
	// and binds `open`; the form's own save button lives in `children`.
	import type { Snippet } from 'svelte';
	import Dialog from '../Dialog.svelte';

	let {
		title,
		description,
		open = $bindable(false),
		children
	}: {
		title: string;
		description?: string;
		/** Kept for call-site compatibility; the trigger now lives in the page header. */
		buttonLabel?: string;
		cancelLabel?: string;
		open?: boolean;
		children: Snippet;
	} = $props();
</script>

<Dialog bind:open {title} size="lg">
	<div class="space-y-4">
		{#if description}
			<p class="-mt-2 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
		{/if}
		{@render children()}
	</div>
</Dialog>
