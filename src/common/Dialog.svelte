<script lang="ts">
	// Shared modal built on native <dialog> + showModal(): the browser gives us
	// the focus trap, Esc, inert background and top layer for free. Open state
	// is a bindable prop; closing via Esc/backdrop/close button calls onclose.
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n';

	let {
		open = $bindable(false),
		title,
		size = 'md',
		dismissible = true,
		onclose,
		children,
		footer
	}: {
		open?: boolean;
		title?: string;
		size?: 'sm' | 'md' | 'lg';
		/** false: Esc / backdrop click do nothing (blocking flows like updates). */
		dismissible?: boolean;
		onclose?: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let el = $state<HTMLDialogElement>();
	const width = $derived({ sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }[size]);

	$effect(() => {
		if (!el) return;
		if (open && !el.open) {
			el.showModal();
			// Native showModal focuses the first focusable (our close X); start in the form instead.
			queueMicrotask(() => el?.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]), select, textarea')?.focus());
		}
		else if (!open && el.open) el.close();
	});

	function close() {
		if (!dismissible) return;
		open = false;
		onclose?.();
	}
</script>

<dialog
	bind:this={el}
	class="dialog m-auto w-[calc(100%-2rem)] {width} rounded-2xl bg-transparent p-0 text-zinc-900 backdrop:bg-zinc-950/40 backdrop:backdrop-blur-[2px] dark:text-zinc-100"
	aria-label={title}
	oncancel={(e) => {
		e.preventDefault();
		close();
	}}
	onclick={(e) => {
		if (e.target === el) close();
	}}
>
	{#if open}
		<div class="bezel">
			<div class="bezel-core p-5">
				{#if title}
					<div class="mb-4 flex items-start justify-between gap-4">
						<h2 class="text-base font-semibold tracking-tight">{title}</h2>
						{#if dismissible}
							<button type="button" class="icon-btn -mr-2 -mt-1 h-7 w-7" aria-label={t('common.close')} onclick={close}>
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
							</button>
						{/if}
					</div>
				{/if}
				{@render children()}
				{#if footer}
					<div class="mt-5 flex flex-wrap justify-end gap-2">{@render footer()}</div>
				{/if}
			</div>
		</div>
	{/if}
</dialog>

<style>
	/* Enter: scale+fade with a spring; backdrop fades. Native <dialog> has no
	   exit hook without JS, so closing is instant (acceptable, Esc feels snappy). */
	.dialog[open] {
		animation: dialog-in 320ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	.dialog[open]::backdrop {
		animation: backdrop-in 240ms cubic-bezier(0.32, 0.72, 0, 1);
	}
	@keyframes dialog-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.97);
		}
	}
	@keyframes backdrop-in {
		from {
			opacity: 0;
		}
	}
</style>
