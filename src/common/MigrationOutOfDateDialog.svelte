<script lang="ts">
	/**
	 * OBS-3.b: blocking dialog shown at boot when the on-disk database
	 * schema version does not match the version this binary was compiled
	 * against (`BookieError::MigrationOutOfDate` from OBS-3.a).
	 *
	 * The dialog is rendered by `src/routes/+layout.svelte` *instead of*
	 * the normal app shell, so no business UI is reachable until one of
	 * the two recovery actions is taken:
	 *   1. Backup wiederherstellen → navigates to `/einstellungen/backup`,
	 *      where the existing restore-from-file flow lives.
	 *   2. App-Daten sichern und schließen → invokes `backup_database`,
	 *      writes the bytes to a user-chosen path via the native save
	 *      dialog, then closes the window. This is the verification step
	 *      called out in the issue.
	 *
	 * The dialog has no dismiss button, no Escape handler, and no
	 * backdrop-click handler — it is a hard stop, not a modal.
	 */
	import { goto } from '$app/navigation';

	import {
		saveAppDataAndClose,
		defaultRecoveryDeps,
		type RecoveryDeps,
		type SaveOutcome
	} from '$lib/boot/recovery-actions';

	type Props = {
		actual?: number;
		expected?: number;
		/** Test seam: inject stub deps in unit/component tests. */
		deps?: RecoveryDeps;
		/** Test seam: override the navigation target. */
		onRestore?: () => void;
	};

	let {
		actual,
		expected,
		deps = defaultRecoveryDeps,
		onRestore = () => goto('/einstellungen/backup')
	}: Props = $props();

	let saving = $state(false);
	let lastOutcome = $state<SaveOutcome | null>(null);

	async function handleSave() {
		saving = true;
		lastOutcome = null;
		try {
			lastOutcome = await saveAppDataAndClose(deps);
		} finally {
			saving = false;
		}
	}

	function handleRestore() {
		onRestore();
	}
</script>

<!--
	The wrapper is a static <div> rather than a <button> because clicking
	the backdrop must NOT dismiss the dialog — this is a hard stop. The
	role/aria-modal attributes are still set so screen readers treat it
	as a modal.
-->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="migration-out-of-date-title"
	aria-describedby="migration-out-of-date-description"
	data-testid="migration-out-of-date-dialog"
>
	<div
		class="card w-full max-w-lg space-y-4 border-red-300 bg-white shadow-xl dark:border-red-900 dark:bg-zinc-900"
	>
		<h2 id="migration-out-of-date-title" class="text-lg font-semibold text-red-700 dark:text-red-400">
			Datenbankversion passt nicht zur Anwendung
		</h2>

		<div id="migration-out-of-date-description" class="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
			<p>
				Die Datenbank auf diesem Gerät hat eine Schemaversion, die diese Version von Bookie nicht
				verwenden kann. Aus Sicherheitsgründen werden keine weiteren Aktionen ausgeführt, bis das
				Problem behoben ist.
			</p>
			{#if typeof actual === 'number' && typeof expected === 'number'}
				<p class="font-mono text-xs text-zinc-600 dark:text-zinc-400">
					Datenbank-Version: {actual} &nbsp;·&nbsp; Erwartete Version: {expected}
				</p>
			{/if}
			<p>
				Bitte stelle ein passendes Backup wieder her oder sichere die aktuellen App-Daten und
				schließe Bookie, bevor du eine kompatible Version installierst.
			</p>
		</div>

		<div class="flex flex-col gap-2 sm:flex-row sm:justify-end">
			<button
				type="button"
				class="btn-secondary"
				onclick={handleRestore}
				disabled={saving}
				data-testid="migration-restore-button"
			>
				Backup wiederherstellen
			</button>
			<button
				type="button"
				class="btn-primary"
				onclick={handleSave}
				disabled={saving}
				data-testid="migration-save-button"
			>
				{saving ? 'Wird gesichert…' : 'App-Daten sichern und schließen'}
			</button>
		</div>

		{#if lastOutcome?.kind === 'cancelled'}
			<p class="text-xs text-zinc-500 dark:text-zinc-400">
				Speichern abgebrochen. Bitte einen Speicherort auswählen oder ein Backup wiederherstellen.
			</p>
		{:else if lastOutcome?.kind === 'failed'}
			<p class="text-xs text-red-600 dark:text-red-400">
				Sichern fehlgeschlagen: {lastOutcome.message}
			</p>
		{/if}
	</div>
</div>
