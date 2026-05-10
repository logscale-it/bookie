<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { startAutoBackupScheduler } from '$lib/s3/auto-backup';
	import { t, setLocale, type Locale } from '$lib/i18n';
	import { getOrganizationSettings, getS3Settings } from '$lib/db/settings';
	import {
		runSchemaVersionCheck,
		type MigrationOutOfDateError
	} from '$lib/boot/schema-check';
	import MigrationOutOfDateDialog from '../common/MigrationOutOfDateDialog.svelte';
	import BootDiagnostics from '$lib/diagnostics/BootDiagnostics.svelte';
	import {
		runBootCheck,
		s3ConfigFromSettings,
		hasBlockingFailure,
		hasS3Warning,
		type BootStatus
	} from '$lib/diagnostics/boot';
	import { createLogger } from '$lib/logger';

	let { children }: { children: Snippet } = $props();

	const log = createLogger('boot');

	// OBS-3.b: gate the entire app shell behind a schema-version check. If
	// the on-disk DB doesn't match the version this binary was compiled
	// against, render the recovery dialog *instead of* the business UI so
	// no command can read or mutate data with a mismatched schema.
	//
	// OPS-1.b: additionally gate on boot_check. While `bootStatus === null`
	// we render a neutral splash; once it resolves, a blocking failure swaps
	// the entire shell for `<BootDiagnostics />` (nav becomes unreachable).
	// S3 failure surfaces as a non-blocking warning banner above the normal
	// layout. The two flows are layered: a MigrationOutOfDate from the
	// schema-version check short-circuits to its dedicated recovery dialog;
	// otherwise we fall through to the general boot_check diagnostics.
	let bootChecked = $state(false);
	let migrationError = $state<MigrationOutOfDateError | null>(null);
	let bootStatus = $state<BootStatus | null>(null);
	let bootError = $state<string | null>(null);

	async function performBootCheck(): Promise<void> {
		bootError = null;
		try {
			// Best-effort load of S3 settings so the backend's S3 probe runs
			// when the user has actually configured a bucket. If settings
			// reads fail (e.g. DB not yet migrated), we still want to invoke
			// boot_check so the user sees the underlying breakage in the
			// diagnostics view rather than a blank screen.
			let s3Config = null;
			try {
				const s3 = await getS3Settings();
				s3Config = s3ConfigFromSettings(s3);
			} catch (e) {
				log.warn('Failed to load S3 settings for boot_check', e);
			}
			bootStatus = await runBootCheck(s3Config);
		} catch (e) {
			// boot_check itself blew up (e.g. command not registered, bridge
			// failure). Surface as a synthetic blocking failure so the user
			// is not silently dropped into a half-broken app.
			log.error('boot_check invocation failed', e);
			bootError = e instanceof Error ? e.message : String(e);
			bootStatus = {
				app_data_dir: { status: 'err', error: { kind: 'Unknown', message: bootError } },
				keyring: { status: 'skipped', reason: 'boot_check failed' },
				s3: { status: 'skipped', reason: 'boot_check failed' },
				schema: { status: 'skipped', reason: 'boot_check failed' }
			};
		}
	}

	onMount(async () => {
		// Schema-version check first: a MigrationOutOfDate is a very specific
		// recovery flow (OBS-3.b) that must not be muddled with the general
		// boot_check diagnostics view. If the schema is OK or the check
		// failed for a non-version reason, fall through to boot_check.
		const result = await runSchemaVersionCheck();
		if (!result.ok && result.error.kind === 'MigrationOutOfDate') {
			migrationError = result.error;
			bootChecked = true;
			return;
		}
		// Run boot_check FIRST (before any side-effectful schedulers) so we
		// never start auto-backup against a broken environment (e.g. a
		// read-only app-data dir would just fail silently).
		await performBootCheck();
		bootChecked = true;
		if (bootStatus && hasBlockingFailure(bootStatus)) {
			// Blocking failure: do not start side-effectful work, do not load
			// org settings (the DB itself may be unreachable). The user fixes
			// the issue and clicks "Erneut prüfen" which re-runs the flow via
			// `performBootCheck`.
			return;
		}
		startAutoBackupScheduler();
		try {
			const orgSettings = await getOrganizationSettings();
			if (orgSettings.default_locale) setLocale(orgSettings.default_locale as Locale);
		} catch (e) {
			log.warn('Failed to load organization settings on boot', e);
		}
	});

	async function retry(): Promise<void> {
		bootStatus = null;
		await performBootCheck();
		if (bootStatus && !hasBlockingFailure(bootStatus)) {
			startAutoBackupScheduler();
			try {
				const orgSettings = await getOrganizationSettings();
				if (orgSettings.default_locale) setLocale(orgSettings.default_locale as Locale);
			} catch (e) {
				log.warn('Failed to load organization settings after retry', e);
			}
		}
	}

	const navItems = [
		{
			get label() { return t('nav.overview'); },
			get shortLabel() { return t('nav.overview'); },
			href: '/uebersicht',
			icon: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z'
		},
		{
			get label() { return t('nav.invoices'); },
			get shortLabel() { return t('nav.invoices'); },
			href: '/rechnungen',
			icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
		},
		{
			get label() { return t('nav.incomingInvoices'); },
			get shortLabel() { return t('nav.incomingShort'); },
			href: '/eingehende-rechnungen',
			icon: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4'
		},
		{
			get label() { return t('nav.projects'); },
			get shortLabel() { return t('nav.projects'); },
			href: '/projekte',
			icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'
		},
		{
			get label() { return t('nav.companies'); },
			get shortLabel() { return t('nav.companiesShort'); },
			href: '/unternehmen',
			icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4'
		},
		{
			get label() { return t('nav.timeTracking'); },
			get shortLabel() { return t('nav.timeTrackingShort'); },
			href: '/zeiterfassung',
			icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z'
		},
		{
			get label() { return t('nav.settings'); },
			get shortLabel() { return t('nav.settingsShort'); },
			href: '/einstellungen',
			icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z'
		}
	];

	const isActive = (href: string, pathname: string) => pathname === href || pathname.startsWith(`${href}/`);
</script>

{#if migrationError}
	<!--
		OBS-3.b: hard-stop on a schema-version mismatch. Render ONLY the
		recovery dialog so no business UI (and crucially, no automatic
		backup scheduler or DB query) can run against an incompatible
		database.
	-->
	<MigrationOutOfDateDialog actual={migrationError.actual} expected={migrationError.expected} />
{:else if !bootChecked || bootStatus === null}
	<!-- Boot probe in flight: neutral splash, NO nav reachable yet. -->
	<div
		class="flex h-screen w-screen items-center justify-center bg-zinc-100 text-sm text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
		data-testid="boot-loading"
	>
		<span>{t('common.loading')}</span>
	</div>
{:else if hasBlockingFailure(bootStatus)}
	<!-- Blocking failure: full-window diagnostics view, nav unreachable. -->
	<BootDiagnostics status={bootStatus} onRetry={retry} />
{:else}
	<div class="flex h-screen overflow-hidden bg-zinc-100 text-sm text-zinc-900 antialiased dark:bg-zinc-900 dark:text-zinc-100">
		<!-- Desktop sidebar -->
		<aside class="hidden w-72 shrink-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50 p-6 md:block dark:border-zinc-700 dark:bg-zinc-800/60">
			<div class="mb-6 flex items-center gap-2.5">
				<img src="/bookie.svg" alt="Bookie" class="h-8 w-8 rounded-lg" />
				<span class="text-base font-semibold tracking-tight">Bookie</span>
			</div>
			<nav class="flex flex-col gap-1">
				{#each navItems as item}
					<a
						href={item.href}
						class={`rounded-md px-3 py-2 text-sm font-medium transition ${isActive(item.href, page.url.pathname) ? 'bg-blue-600 text-white' : 'text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-200 dark:hover:bg-zinc-700'}`}
					>
						{item.label}
					</a>
				{/each}
			</nav>
		</aside>

		<main class="flex-1 overflow-y-auto p-4 pb-20 md:p-6 md:pb-6">
			{#if hasS3Warning(bootStatus)}
				<!-- OPS-1.b: S3 failure is a warning, not blocking. Surface a
				     non-modal banner so the user knows auto-backup is broken
				     without locking them out of the app. -->
				<div
					class="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
					role="status"
					data-testid="boot-s3-warning"
				>
					S3-Speicher ist nicht erreichbar. Automatische Backups funktionieren
					möglicherweise nicht. Prüfen Sie die S3-Einstellungen.
				</div>
			{/if}
			{@render children()}
		</main>

		<!-- Mobile bottom navigation -->
		<nav class="fixed bottom-0 left-0 right-0 z-50 flex h-16 items-center justify-around border-t border-zinc-200 bg-white md:hidden dark:border-zinc-700 dark:bg-zinc-800">
			{#each navItems as item}
				<a
					href={item.href}
					class={`flex flex-col items-center gap-0.5 px-1 py-1 text-center transition ${isActive(item.href, page.url.pathname) ? 'text-blue-600' : 'text-zinc-500 dark:text-zinc-400'}`}
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
					</svg>
					<span class="text-[10px] leading-tight">{item.shortLabel}</span>
				</a>
			{/each}
		</nav>
	</div>
{/if}
