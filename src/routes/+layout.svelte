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
	import CommandPalette from '../common/CommandPalette.svelte';
	import Toaster from '../common/Toaster.svelte';
	import { commandPalette } from '$lib/ui/command.svelte';
	import { theme } from '$lib/ui/theme.svelte';
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
				app_data: { kind: 'Failed', error: { kind: 'Unknown', message: bootError } },
				keyring: { kind: 'Skipped' },
				s3: { kind: 'Skipped' },
				schema: { kind: 'Skipped' }
			};
		}
	}

	const themeMeta = $derived(
		theme.value === 'light'
			? { label: t('common.themeLight'), icon: 'M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z' }
			: theme.value === 'dark'
				? { label: t('common.themeDark'), icon: 'M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z' }
				: { label: t('common.themeSystem'), icon: 'M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z' }
	);

	onMount(() => {
		// Apply the saved/OS theme as early as possible.
		theme.init();
	});

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
		<CommandPalette />
		<Toaster />
		<!-- Desktop sidebar -->
		<aside class="hidden w-72 shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-zinc-50 p-6 md:flex dark:border-zinc-700 dark:bg-zinc-800/60">
			<div class="mb-5 flex items-center gap-2.5">
				<img src="/bookie.svg" alt="Bookie" class="h-8 w-8 rounded-lg" />
				<span class="text-base font-semibold tracking-tight">Bookie</span>
			</div>
			<button
				type="button"
				onclick={() => (commandPalette.open = true)}
				class="mb-5 flex w-full items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-400 transition hover:border-zinc-300 hover:text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-zinc-600 dark:hover:text-zinc-300"
			>
				<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
				<span class="flex-1">{t('common.search')}…</span>
				<kbd class="rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] font-medium dark:border-zinc-600">⌘K</kbd>
			</button>
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

			<button
				type="button"
				onclick={() => theme.cycle()}
				class="mt-auto flex items-center gap-2 rounded-md px-3 py-2 pt-2 text-xs font-medium text-zinc-500 transition hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-700"
				aria-label={t('common.theme')}
				title={t('common.theme')}
			>
				<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d={themeMeta.icon} /></svg>
				<span>{themeMeta.label}</span>
			</button>
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
