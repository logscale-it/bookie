<script lang="ts">
	// Sidebar stopwatch. Idle: one "start" button. Running: pulsing dot, ticking
	// hh:mm:ss, description, stop (→ prefilled entry dialog) and discard.
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n';
	import { timer } from '$lib/ui/timer.svelte';
	import { formatElapsed } from '$lib/ui/timer-math';

	let now = $state(Date.now());

	$effect(() => {
		if (!timer.running) return;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	const elapsed = $derived(timer.startedAt ? formatElapsed(now - Date.parse(timer.startedAt)) : '00:00:00');

	function stop() {
		if (timer.stop()) goto('/zeiterfassung?fromTimer=1');
	}
</script>

<div class="w-full max-w-[15rem]">
	{#if timer.running}
		<div class="animate-pop space-y-2 rounded-xl bg-white p-2.5 shadow-soft ring-1 ring-zinc-900/5 dark:bg-zinc-800/70 dark:shadow-none dark:ring-white/10">
			<div class="flex items-center gap-2">
				<span class="relative flex h-2 w-2 shrink-0" aria-hidden="true">
					<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60 motion-reduce:hidden"></span>
					<span class="relative inline-flex h-2 w-2 rounded-full bg-red-500"></span>
				</span>
				<span class="flex-1 text-sm font-medium tabular-nums text-zinc-900 dark:text-zinc-100" role="timer" aria-label={t('timeTracking.timerRunning')}>{elapsed}</span>
				<button type="button" class="icon-btn icon-btn-danger h-7 w-7" title={t('timeTracking.timerDiscard')} aria-label={t('timeTracking.timerDiscard')} onclick={() => timer.discard()}>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
				</button>
				<button type="button" class="icon-btn icon-btn-blue h-7 w-7" title={t('timeTracking.timerStop')} aria-label={t('timeTracking.timerStop')} onclick={stop}>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" /></svg>
				</button>
			</div>
			<input
				type="text"
				class="w-full rounded-md bg-zinc-50 px-2 py-1 text-xs text-zinc-700 ring-1 ring-zinc-900/5 outline-none transition placeholder:text-zinc-400 focus:ring-2 focus:ring-accent-500/40 dark:bg-zinc-900/40 dark:text-zinc-200 dark:ring-white/10"
				aria-label={t('common.description')}
				placeholder={t('timeTracking.timerPlaceholder')}
				bind:value={timer.description}
			/>
		</div>
	{:else}
		<button
			type="button"
			class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 ring-1 ring-zinc-900/5 transition duration-200 ease-spring hover:bg-white hover:text-zinc-900 active:scale-[0.98] dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
			onclick={() => timer.start()}
		>
			<svg class="h-4 w-4 text-accent-600 dark:text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" /></svg>
			{t('timeTracking.timerStart')}
		</button>
	{/if}
</div>
