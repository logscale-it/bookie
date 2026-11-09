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
	 * Rendered via the shared <Dialog> with `dismissible={false}`: no close
	 * button, Escape and backdrop clicks do nothing — it is a hard stop.
	 */
	import { goto } from '$app/navigation';
	import Dialog from './Dialog.svelte';
	import { t, tp } from '$lib/i18n';

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

<!-- Opaque full-window backdrop: the window is transparent on macOS and
     nothing else is rendered behind this hard stop. -->
<div class="h-screen w-screen bg-zinc-100 dark:bg-zinc-900">
	<Dialog open title={t('migrationDialog.title')} dismissible={false}>
		<div class="space-y-4" data-testid="migration-out-of-date-dialog">
			<div class="flex gap-3">
				<span
					class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 ring-1 ring-red-600/10 dark:bg-red-900/30 dark:text-red-400"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"
						><path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
						/></svg
					>
				</span>
				<div class="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
					<p>
						{t('migrationDialog.body')}
					</p>
					{#if typeof actual === 'number' && typeof expected === 'number'}
						<p class="font-mono text-xs text-zinc-500 dark:text-zinc-400">
							{t('migrationDialog.dbVersion')} {actual} &nbsp;·&nbsp; {t('migrationDialog.expectedVersion')} {expected}
						</p>
					{/if}
					<p>
						{t('migrationDialog.advice')}
					</p>
				</div>
			</div>

			{#if lastOutcome?.kind === 'cancelled'}
				<p class="text-xs text-zinc-500 dark:text-zinc-400">
					{t('migrationDialog.cancelled')}
				</p>
			{:else if lastOutcome?.kind === 'failed'}
				<p class="text-xs text-red-600 dark:text-red-400">
					{tp('migrationDialog.failed', { message: lastOutcome.message })}
				</p>
			{/if}
		</div>
		{#snippet footer()}
			<button
				type="button"
				class="btn-secondary"
				onclick={handleRestore}
				disabled={saving}
				data-testid="migration-restore-button"
			>
				{t('migrationDialog.restore')}
			</button>
			<button
				type="button"
				class="btn-primary"
				onclick={handleSave}
				disabled={saving}
				data-testid="migration-save-button"
			>
				{saving ? t('migrationDialog.saving') : t('migrationDialog.saveAndClose')}
			</button>
		{/snippet}
	</Dialog>
</div>
