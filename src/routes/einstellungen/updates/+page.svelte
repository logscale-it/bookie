<script lang="ts">
	import { check, type Update } from '@tauri-apps/plugin-updater';
	import { relaunch } from '@tauri-apps/plugin-process';

	let update = $state<Update | null>(null);
	let busy = $state(false);
	let feedback = $state('');

	async function checkForUpdate() {
		busy = true;
		feedback = '';
		try {
			update = await check();
			if (!update) feedback = 'Bookie ist auf dem neuesten Stand.';
		} catch (e) {
			feedback = `Update-Prüfung fehlgeschlagen: ${e}`;
		} finally {
			busy = false;
		}
	}

	async function install() {
		if (!update) return;
		busy = true;
		feedback = 'Update wird heruntergeladen …';
		try {
			await update.downloadAndInstall();
			await relaunch();
		} catch (e) {
			feedback = `Installation fehlgeschlagen: ${e}`;
			busy = false;
		}
	}
</script>

<section class="card space-y-3">
	<button class="btn-secondary" onclick={checkForUpdate} disabled={busy}>
		Nach Updates suchen
	</button>
	{#if update}
		<p class="text-sm">Version {update.version} ist verfügbar.</p>
		<button class="btn-primary" onclick={install} disabled={busy}>
			Installieren und neu starten
		</button>
	{/if}
	{#if feedback}<p class="text-sm">{feedback}</p>{/if}
</section>
