<script lang="ts">
	import { onMount } from 'svelte';
	import { check, type Update } from '@tauri-apps/plugin-updater';
	import { relaunch } from '@tauri-apps/plugin-process';
	import { createLogger } from '$lib/logger';
	import { t, tp } from '$lib/i18n';
	import Dialog from './Dialog.svelte';

	const log = createLogger('updater');
	const SKIP_KEY = 'bookie.update.skipped';

	let update = $state<Update | null>(null);
	let busy = $state(false);
	let error = $state('');
	let total = $state(0);
	let loaded = $state(0);

	onMount(async () => {
		// Offline / GitHub unreachable / dev build: stay silent.
		try {
			const found = await check();
			let skipped: string | null = null;
			try {
				skipped = localStorage.getItem(SKIP_KEY);
			} catch {
				// storage unavailable -> always prompt
			}
			if (found && found.version !== skipped) update = found;
		} catch (e) {
			log.warn('Update check failed', e);
		}
	});

	function later() {
		try {
			if (update) localStorage.setItem(SKIP_KEY, update.version);
		} catch {
			// ignore
		}
		update = null;
	}

	async function install() {
		if (!update) return;
		busy = true;
		error = '';
		loaded = 0;
		try {
			await update.downloadAndInstall((ev) => {
				if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
				else if (ev.event === 'Progress') loaded += ev.data.chunkLength;
			});
			await relaunch();
		} catch (e) {
			log.error('Update install failed', e);
			error = tp('update.failed', { error: String(e) });
			busy = false;
		}
	}
</script>

{#if update}
	<!-- Esc / backdrop = "Später"; blocked while the download runs. -->
	<Dialog open title={t('update.title')} size="sm" dismissible={!busy} onclose={later}>
		<div class="space-y-3" data-testid="update-prompt">
			<p class="text-sm text-zinc-600 dark:text-zinc-300">
				{tp('update.body', { version: update.version })}
			</p>
			{#if update.body}
				<p
					class="max-h-32 overflow-y-auto rounded-lg bg-zinc-50 p-3 text-xs whitespace-pre-wrap text-zinc-500 ring-1 ring-zinc-900/5 dark:bg-zinc-900/40 dark:text-zinc-400 dark:ring-white/10"
				>
					{update.body}
				</p>
			{/if}
			{#if busy}
				<div class="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-700">
					<div
						class="h-full origin-left rounded-full bg-accent-600 transition-transform duration-300 ease-out-expo {total
							? ''
							: 'animate-pulse'}"
						style="transform: scaleX({total ? Math.min(1, loaded / total) : 1})"
					></div>
				</div>
			{/if}
			{#if error}<p class="text-sm text-red-600 dark:text-red-400">{error}</p>{/if}
		</div>
		{#snippet footer()}
			<button class="btn-secondary" onclick={later} disabled={busy}>{t('update.later')}</button>
			<button class="btn-primary" onclick={install} disabled={busy}>{t('update.install')}</button>
		{/snippet}
	</Dialog>
{/if}
