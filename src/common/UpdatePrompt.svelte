<script lang="ts">
	import { onMount } from 'svelte';
	import { check, type Update } from '@tauri-apps/plugin-updater';
	import { relaunch } from '@tauri-apps/plugin-process';
	import { createLogger } from '$lib/logger';

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
			error = `Installation fehlgeschlagen: ${e}`;
			busy = false;
		}
	}
</script>

{#if update}
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="update-title"
		data-testid="update-prompt"
	>
		<div class="card w-full max-w-md space-y-3">
			<h2 id="update-title" class="text-base font-semibold">Update verfügbar</h2>
			<p class="text-sm">
				Bookie {update.version} ist verfügbar. Nicht gespeicherte Eingaben gehen beim Neustart
				verloren.
			</p>
			{#if update.body}
				<p class="max-h-32 overflow-y-auto text-xs whitespace-pre-wrap text-zinc-500">
					{update.body}
				</p>
			{/if}
			{#if busy}
				<progress class="w-full" value={loaded} max={total || undefined}></progress>
			{/if}
			{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
			<div class="flex justify-end gap-2">
				<button class="btn-secondary" onclick={later} disabled={busy}>Später</button>
				<button class="btn-primary" onclick={install} disabled={busy}>
					Jetzt installieren
				</button>
			</div>
		</div>
	</div>
{/if}
