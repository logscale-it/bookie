<script lang="ts">
	// Renders the global toast stack (bottom-right). Mounted once in the root
	// layout; content is driven entirely by the `toasts` rune store.
	import { fly, fade } from 'svelte/transition';
	import { toasts, type ToastKind } from '$lib/ui/toasts.svelte';

	const STYLES: Record<ToastKind, string> = {
		success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
		error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/40 dark:text-red-200',
		info: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
	};

	const ICONS: Record<ToastKind, string> = {
		success: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
		error: 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z',
		info: 'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z'
	};
</script>

{#if toasts.items.length > 0}
	<div class="pointer-events-none fixed bottom-4 right-4 z-[110] flex w-full max-w-sm flex-col gap-2" aria-live="polite" role="status">
		{#each toasts.items as toast (toast.id)}
			<div
				class="pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg {STYLES[toast.kind]}"
				in:fly={{ y: 12, duration: 200 }}
				out:fade={{ duration: 150 }}
			>
				<svg class="mt-0.5 h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d={ICONS[toast.kind]} /></svg>
				<span class="min-w-0 flex-1">{toast.message}</span>
				<button
					type="button"
					onclick={() => toasts.dismiss(toast.id)}
					class="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 opacity-60 transition hover:opacity-100"
					aria-label="Schließen"
				>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
				</button>
			</div>
		{/each}
	</div>
{/if}
