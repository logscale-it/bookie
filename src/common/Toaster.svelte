<script lang="ts">
	// Renders the global toast stack (bottom-right). Mounted once in the root
	// layout; content is driven entirely by the `toasts` rune store. Hovering
	// the stack pauses every auto-dismiss timer.
	import { fly, fade } from 'svelte/transition';
	import { backOut } from 'svelte/easing';
	import { flip } from 'svelte/animate';
	import { toasts, type ToastKind } from '$lib/ui/toasts.svelte';
	import { t } from '$lib/i18n';

	const DOT: Record<ToastKind, string> = {
		success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
		error: 'bg-red-500/15 text-red-600 dark:text-red-400',
		info: 'bg-accent-500/15 text-accent-600 dark:text-accent-400'
	};
	const BAR: Record<ToastKind, string> = {
		success: 'bg-emerald-500',
		error: 'bg-red-500',
		info: 'bg-accent-500'
	};

	const ICONS: Record<ToastKind, string> = {
		success: 'M4.5 12.75l6 6 9-13.5',
		error: 'M12 9v3.75m0 3.75h.008v.008H12v-.008z',
		info: 'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M12 8.25h.008v.008H12V8.25z'
	};
</script>

{#if toasts.items.length > 0}
	<div
		class="pointer-events-none fixed bottom-20 right-4 z-[110] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 md:bottom-4"
		aria-live="polite"
		role="status"
		onmouseenter={() => toasts.pause()}
		onmouseleave={() => toasts.resume()}
	>
		{#each toasts.items as toast (toast.id)}
			<div
				class="pointer-events-auto relative flex items-center gap-3 overflow-hidden rounded-2xl bg-white/95 py-2.5 pl-2.5 pr-3 text-sm text-zinc-800 shadow-float ring-1 ring-zinc-900/[0.07] backdrop-blur-xl dark:bg-zinc-800/95 dark:text-zinc-100 dark:ring-white/10"
				in:fly={{ y: 16, duration: 380, easing: backOut }}
				out:fade={{ duration: 160 }}
				animate:flip={{ duration: 280 }}
			>
				<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full {DOT[toast.kind]}">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d={ICONS[toast.kind]} /></svg>
				</span>
				<span class="min-w-0 flex-1 leading-snug">{toast.message}</span>
				{#if toast.action}
					{@const action = toast.action}
					<button
						type="button"
						class="shrink-0 rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition duration-200 ease-spring hover:bg-zinc-700 active:scale-95 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
						onclick={() => {
							action.run();
							toasts.dismiss(toast.id);
						}}
					>
						{action.label}
					</button>
				{/if}
				<button
					type="button"
					onclick={() => toasts.dismiss(toast.id)}
					class="shrink-0 rounded-full p-1 text-zinc-400 transition duration-200 ease-spring hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
					aria-label={t('common.close')}
				>
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
				</button>
				{#if toast.timeoutMs > 0}
					<span
						class="toast-bar absolute bottom-0 left-0 h-0.5 w-full origin-left opacity-60 {BAR[toast.kind]}"
						style="animation-duration: {toast.timeoutMs}ms; animation-play-state: {toasts.paused ? 'paused' : 'running'}"
					></span>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-bar {
		animation-name: drain;
		animation-timing-function: linear; /* a countdown is the one honest linear motion */
		animation-fill-mode: forwards;
	}
	@keyframes drain {
		to {
			transform: scaleX(0);
		}
	}
</style>
