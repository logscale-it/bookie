<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import EmptyState from '../common/EmptyState.svelte';
	import { onMount } from 'svelte';
	import { startAutoBackupScheduler } from '$lib/s3/auto-backup';
	import { listCompanies } from '$lib/db/companies';
	import { runDueRecurring } from '$lib/db/recurring';
	import { t, tp, setLocale, getLocaleFormatting, type Locale } from '$lib/i18n';
	import { getOrganizationSettings, getS3Settings } from '$lib/db/settings';
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { net } from '$lib/net.svelte';
	import { toasts } from '$lib/ui/toasts.svelte';
	import {
		runSchemaVersionCheck,
		type MigrationOutOfDateError
	} from '$lib/boot/schema-check';
	import MigrationOutOfDateDialog from '../common/MigrationOutOfDateDialog.svelte';
	import BootDiagnostics from '$lib/diagnostics/BootDiagnostics.svelte';
	import CommandPalette from '../common/CommandPalette.svelte';
	import Toaster from '../common/Toaster.svelte';
	import UpdatePrompt from '../common/UpdatePrompt.svelte';
	import { commandPalette } from '$lib/ui/command.svelte';
	import { theme } from '$lib/ui/theme.svelte';
	import {
		runBootCheck,
		hasBlockingFailure,
		type BootStatus
	} from '$lib/diagnostics/boot';
	import { createLogger } from '$lib/logger';
	import { api, cloud, loadCloudToken, logout } from '$lib/cloud';
	import { can, initials, isSub, loadSession, session } from '$lib/session.svelte';
	import Presence from '../common/Presence.svelte';
	import { presence } from '$lib/presence.svelte';
	import TimerWidget from '../common/TimerWidget.svelte';

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
			bootStatus = await runBootCheck();
		} catch (e) {
			// boot_check itself blew up (e.g. command not registered, bridge
			// failure). Surface as a synthetic blocking failure so the user
			// is not silently dropped into a half-broken app.
			log.error('boot_check invocation failed', e);
			bootError = e instanceof Error ? e.message : String(e);
			bootStatus = {
				app_data: { kind: 'Failed', error: { kind: 'Unknown', message: bootError } },
				keyring: { kind: 'Skipped' },
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

	// macOS only: the window is transparent with native `sidebar` vibrancy
	// (tauri.conf.json), so the shell root is see-through and the sidebar only
	// tints it. Elsewhere (Linux has no material, Windows 10 lacks mica) every
	// surface stays opaque. In a plain browser there is no native window at all.
	const vibrant =
		typeof navigator !== 'undefined' &&
		/Mac/.test(navigator.platform) &&
		'__TAURI_INTERNALS__' in window;
	const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl ';

	onMount(() => {
		// Apply the saved/OS theme as early as possible.
		theme.init();
		document.documentElement.classList.toggle('vibrancy', vibrant);
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
		// The cloud session token comes from the OS keyring; pages call cloud()
		// synchronously once bootChecked renders them.
		await loadCloudToken();
		await loadSession();
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
		// Materialise any recurring invoices/costs that have come due since the
		// app was last opened. Best-effort: a failure here must never block the
		// shell.
		try {
			const companies = await listCompanies();
			const today = new Date().toISOString().slice(0, 10);
			for (const c of companies) await runDueRecurring(c.id, today);
		} catch (e) {
			log.warn('Failed to run recurring entries on boot', e);
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
			show: () => can('reports'),
			icon: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z'
		},
		{
			get label() { return t('nav.advisor'); },
			get shortLabel() { return t('nav.advisorShort'); },
			href: '/finanzberater',
			show: () => can('reports'),
			icon: 'M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
		},
		{
			get label() { return t('nav.invoices'); },
			get shortLabel() { return t('nav.invoices'); },
			href: '/rechnungen',
			show: () => can('invoices'),
			icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
		},
		{
			get label() { return t('nav.incomingInvoices'); },
			get shortLabel() { return t('nav.incomingShort'); },
			href: '/eingehende-rechnungen',
			show: () => !isSub(), // server forbids every receipt route for subcontractors
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
			get label() { return t('nav.team'); },
			get shortLabel() { return t('nav.team'); },
			href: '/team',
			// Cloud: admin and team leads (team_time or reports grant). Local: the cloud teaser.
			show: () => !cloud() || can('team_time') || can('reports'),
			icon: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z'
		},
		{
			get label() { return t('nav.leave'); },
			get shortLabel() { return t('nav.leave'); },
			href: '/urlaub',
			// Employees only: subcontractors are not part of the leave flow (server 403s them). Local: the cloud teaser.
			show: () => !cloud() || !isSub(),
			icon: 'M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z'
		},
		{
			get label() { return t('nav.settings'); },
			get shortLabel() { return t('nav.settingsShort'); },
			href: '/einstellungen',
			icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z'
		}
	];

	const isActive = (href: string, pathname: string) => pathname === href || pathname.startsWith(`${href}/`);
	// Cloud: hide areas the caller has no grant for (the server enforces it anyway).
	const visibleNav = $derived(navItems.filter((i) => i.show?.() ?? true));
	// Direct URL into a hidden area (bookmark, palette, link): show a notice instead of a page that only collects 403s.
	const forbidden = $derived(navItems.some((i) => i.show && !i.show() && isActive(i.href, page.url.pathname)));

	const ROLE_KEY = { admin: 'shell.roleAdmin', member: 'shell.roleMember', subcontractor: 'shell.roleSubcontractor' } as const;
	const roleLabel = (role: keyof typeof ROLE_KEY) => t(ROLE_KEY[role]);
	const company = $derived(session.company);
	// cloud() reads localStorage (not reactive); session.me changes whenever
	// the mode does, so it serves as the dependency.
	const isCloud = $derived.by(() => {
		void session.me;
		return cloud() !== null;
	});

	// Sliding nav indicator: items are a fixed 36px + 2px gap, so the pill's
	// offset is plain arithmetic (no DOM measuring).
	const activeIndex = $derived(visibleNav.findIndex((i) => isActive(i.href, page.url.pathname)));

	// ---- Status chip (sidebar footer) -----------------------------------
	type Tone = 'ok' | 'warn' | 'bad' | 'none';
	let backupStatus = $state<{ tone: Tone; label: string } | null>(null);
	const shellReady = $derived(!migrationError && !!bootStatus && !hasBlockingFailure(bootStatus));

	function ago(iso: string): string {
		const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
		const rtf = new Intl.RelativeTimeFormat(getLocaleFormatting(), { style: 'short', numeric: 'auto' });
		if (mins < 60) return rtf.format(-mins, 'minute');
		if (mins < 1440) return rtf.format(-Math.round(mins / 60), 'hour');
		return rtf.format(-Math.round(mins / 1440), 'day');
	}

	// Same source as the dashboard banner: settings_s3.last_auto_backup_*,
	// written by performBackup() for both scheduled and manual backups.
	async function loadBackupStatus(): Promise<void> {
		if (cloud()) return;
		try {
			const s3 = await getS3Settings(false);
			const at = s3.last_auto_backup_at;
			if (!s3.enabled) backupStatus = { tone: 'none', label: t('shell.statusLocalOnly') };
			else if (s3.last_auto_backup_status === 'failure')
				backupStatus = { tone: 'bad', label: t('shell.statusLocalBackupFailed') };
			else if (!at) backupStatus = { tone: 'warn', label: t('shell.statusLocalNoBackup') };
			else
				backupStatus = {
					// Auto-backup runs daily; two missed days is worth a nudge.
					tone: Date.now() - new Date(at).getTime() > 48 * 3600_000 ? 'warn' : 'ok',
					label: tp('shell.statusLocalBackup', { ago: ago(at) })
				};
		} catch {
			backupStatus = null;
		}
	}

	$effect(() => {
		void page.url.pathname; // refresh on navigation (e.g. after a manual backup)
		if (!shellReady) return;
		loadBackupStatus();
		const id = setInterval(loadBackupStatus, 60_000);
		return () => clearInterval(id);
	});

	const statusChip = $derived(
		isCloud
			? net.offline
				? { tone: 'warn' as Tone, label: t('shell.statusOffline'), href: '/einstellungen/cloud' }
				: { tone: 'ok' as Tone, label: t('shell.statusCloud'), href: '/einstellungen/cloud' }
			: backupStatus && { ...backupStatus, href: '/einstellungen/backup' }
	);
	const DOT: Record<Tone, string> = {
		ok: 'bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/0.15)]',
		warn: 'bg-amber-500 shadow-[0_0_0_3px_rgb(245_158_11/0.18)]',
		bad: 'bg-red-500 shadow-[0_0_0_3px_rgb(239_68_68/0.18)]',
		none: 'bg-zinc-400 dark:bg-zinc-500'
	};

	// Every page loads its data on mount, so a company switch reloads the app.
	let switchingTo = $state<string | null>(null);
	async function switchCompany(companyId: number, name: string) {
		switchingTo = name;
		try {
			await api('/session/company', 'POST', { companyId });
			location.href = '/';
		} catch (e) {
			switchingTo = null;
			toasts.error(e instanceof Error ? e.message : String(e));
		}
	}
	async function signOut() {
		await logout();
		location.href = '/einstellungen/cloud';
	}
</script>

<!-- The org switcher / user menu are <details>: close them on outside click or Esc. -->
<svelte:window
	onpointerdown={(e) => {
		for (const d of document.querySelectorAll<HTMLDetailsElement>('details[open]'))
			if (!d.contains(e.target as Node)) d.open = false;
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') for (const d of document.querySelectorAll<HTMLDetailsElement>('details[open]')) d.open = false;
	}}
/>

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
		class="flex h-screen w-screen flex-col items-center justify-center gap-5 bg-zinc-100 bg-[radial-gradient(ellipse_at_center,rgb(255_255_255/0.95),transparent_65%)] text-sm text-zinc-900 dark:bg-zinc-900 dark:bg-[radial-gradient(ellipse_at_center,rgb(255_255_255/0.05),transparent_65%)] dark:text-zinc-100"
		data-testid="boot-loading"
	>
		<img src="/bookie.svg" alt="" class="breathe h-16 w-16 rounded-2xl shadow-float" />
		<span class="text-xs tracking-wide text-zinc-400">{t('common.loading')}</span>
	</div>
{:else if hasBlockingFailure(bootStatus)}
	<!-- Blocking failure: full-window diagnostics view, nav unreachable. -->
	<BootDiagnostics status={bootStatus} onRetry={retry} />
{:else}
	<div
		class="flex h-screen overflow-hidden text-sm text-zinc-900 antialiased dark:text-zinc-100 {vibrant
			? 'bg-transparent'
			: 'bg-zinc-200/70 dark:bg-zinc-950'}"
	>
		<CommandPalette />
		<Toaster />
		<UpdatePrompt />
		<!-- Desktop sidebar: translucent; on macOS the native vibrancy shows through. -->
		<aside
			class="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-zinc-900/[0.06] bg-zinc-50/60 p-4 md:flex dark:border-white/[0.06] dark:bg-zinc-900/50"
		>
			{#if company && session.me}
				<!-- Cloud: the active company is the workspace; switch between companies here. -->
				<details class="group relative mb-4" data-testid="org-switcher">
					<summary
						class="-m-1 flex cursor-pointer list-none items-center gap-2.5 rounded-lg p-1.5 transition-colors duration-200 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.06]"
					>
						{#if session.me.active?.logo}
							<img src={session.me.active.logo} alt="" class="h-8 w-8 shrink-0 rounded-lg bg-white object-contain ring-1 ring-zinc-900/5" />
						{:else}
							<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-600 text-xs font-semibold text-white shadow-soft">{initials(company.name)}</span>
						{/if}
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-semibold tracking-tight">{company.name}</span>
							<span class="block text-xs text-zinc-500 dark:text-zinc-400">
								{roleLabel(company.role)}{session.me.active
									? ` · ${session.me.active.seats} ${session.me.active.seats === 1 ? t('shell.person') : t('shell.persons')}`
									: ''}
							</span>
						</span>
						<svg class="h-4 w-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 15L12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9" /></svg>
					</summary>
					<div
						class="absolute left-0 right-0 z-20 mt-2 origin-top animate-pop rounded-xl bg-white/95 p-1 shadow-float ring-1 ring-zinc-900/5 backdrop-blur-xl dark:bg-zinc-800/95 dark:ring-white/10"
					>
						{#each session.me.companies as c (c.id)}
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-zinc-900/[0.04] disabled:cursor-default dark:hover:bg-white/[0.06]"
								disabled={c.id === company.id}
								onclick={() => switchCompany(c.id, c.name)}
							>
								<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-[10px] font-semibold ring-1 ring-zinc-900/5 dark:bg-zinc-700 dark:ring-white/10">{initials(c.name)}</span>
								<span class="min-w-0 flex-1 truncate">{c.name}</span>
								<span class="text-[10px] text-zinc-500 dark:text-zinc-400">{c.paid ? roleLabel(c.role) : t('shell.noSubscription')}</span>
								{#if c.id === company.id}
									<svg class="h-4 w-4 text-accent-600 dark:text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
								{/if}
							</button>
						{/each}
						<div class="my-1 h-px bg-zinc-900/5 dark:bg-white/10"></div>
						<a href="/einstellungen/cloud" class="block rounded-lg px-2 py-1.5 text-xs text-zinc-500 transition-colors duration-150 hover:bg-zinc-900/[0.04] dark:text-zinc-400 dark:hover:bg-white/[0.06]">{t('shell.manageCompanies')}</a>
					</div>
				</details>
			{:else}
				<div class="mb-4 flex items-center gap-2.5 px-1">
					<img src="/bookie.svg" alt="Bookie" class="h-8 w-8 rounded-lg shadow-soft" />
					<span class="text-base font-semibold tracking-tight">Bookie</span>
				</div>
			{/if}
			<button
				type="button"
				onclick={() => (commandPalette.open = true)}
				class="mb-4 flex w-full items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-left text-sm text-zinc-400 shadow-soft ring-1 ring-zinc-900/5 transition duration-200 ease-spring hover:bg-white hover:text-zinc-600 active:scale-[0.99] dark:bg-white/5 dark:shadow-none dark:ring-white/10 dark:hover:bg-white/10 dark:hover:text-zinc-300"
			>
				<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
				<span class="flex-1">{t('common.search')}…</span>
				<kbd class="kbd">{MOD}K</kbd>
			</button>
			<nav class="relative flex flex-col gap-0.5">
				<!-- One indicator pill that slides to the active item. -->
				<span
					aria-hidden="true"
					class="pointer-events-none absolute inset-x-0 top-0 h-9 rounded-lg bg-white shadow-soft ring-1 ring-zinc-900/5 transition-[transform,opacity] duration-[350ms] ease-spring dark:bg-white/10 dark:shadow-none dark:ring-white/10"
					style="transform: translateY({Math.max(activeIndex, 0) * 38}px); opacity: {activeIndex < 0 ? 0 : 1}"
				></span>
				{#each visibleNav as item, i (item.href)}
					<a
						href={item.href}
						aria-current={i === activeIndex ? 'page' : undefined}
						class="relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors duration-200 {i ===
						activeIndex
							? 'text-zinc-900 dark:text-white'
							: 'text-zinc-500 hover:bg-zinc-900/[0.03] hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-200'}"
					>
						<svg
							class="h-[18px] w-[18px] shrink-0 transition-colors duration-200 {i === activeIndex
								? 'text-accent-600 dark:text-accent-400'
								: 'text-zinc-400 dark:text-zinc-500'}"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d={item.icon} /></svg
						>
						{item.label}
					</a>
				{/each}
			</nav>

			<div class="mt-auto flex flex-col gap-1 pt-4">
				<TimerWidget />

				{#if statusChip}
					<a
						href={statusChip.href}
						class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition-colors duration-200 hover:bg-zinc-900/[0.04] hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
						data-testid="status-chip"
					>
						<span class="h-1.5 w-1.5 shrink-0 rounded-full {DOT[statusChip.tone]}"></span>
						<span class="truncate">{statusChip.label}</span>
					</a>
				{/if}

				{#if company && session.me}
					<!-- Cloud: who is signed in, with account and team shortcuts. -->
					<details class="relative" data-testid="user-menu">
						<summary
							class="flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors duration-200 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.06]"
						>
							<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-semibold ring-1 ring-zinc-900/5 dark:bg-zinc-700 dark:ring-white/10">{initials(session.me.user.name)}</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-xs font-medium">{session.me.user.name}</span>
								<span class="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">{session.me.user.email}</span>
							</span>
						</summary>
						<div
							class="absolute bottom-full left-0 right-0 z-20 mb-2 origin-bottom animate-pop rounded-xl bg-white/95 p-1 text-sm shadow-float ring-1 ring-zinc-900/5 backdrop-blur-xl dark:bg-zinc-800/95 dark:ring-white/10"
						>
							<a href="/einstellungen/cloud" class="block rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.06]">{t('shell.account')}</a>
							{#if company.role === 'admin'}
								<a href="/einstellungen/team" class="block rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.06]">{t('shell.manageTeam')}</a>
							{/if}
							<div class="my-1 h-px bg-zinc-900/5 dark:bg-white/10"></div>
							<button type="button" onclick={signOut} class="block w-full rounded-lg px-2 py-1.5 text-left text-red-600 transition-colors duration-150 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20">{t('shell.signOut')}</button>
						</div>
					</details>
				{/if}
				<button
					type="button"
					onclick={() => theme.cycle()}
					class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-500 transition-colors duration-200 hover:bg-zinc-900/[0.04] dark:text-zinc-400 dark:hover:bg-white/[0.06]"
					aria-label={t('common.theme')}
					title={t('common.theme')}
				>
					<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d={themeMeta.icon} /></svg>
					<span>{themeMeta.label}</span>
				</button>
			</div>
		</aside>

		<!-- Main stays opaque so content never sits on the vibrancy material. -->
		<main class="relative flex-1 overflow-y-auto bg-zinc-100 pb-20 md:pb-0 dark:bg-zinc-900">
			{#if isCloud && net.offline}
				<div
					class="sticky top-0 z-30 flex items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-50/90 px-4 py-1.5 text-xs font-medium text-amber-900 backdrop-blur-md dark:bg-amber-950/80 dark:text-amber-100"
					role="status"
					data-testid="offline-bar"
					transition:fly={{ y: -12, duration: 280, easing: cubicOut }}
				>
					<span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>
					{t('shell.offlineBar')}
				</div>
			{/if}
			<div class="p-4 md:p-6">
				<!-- Cloud: who else is online; collapses when alone or local. -->
				<Presence />
				{#if company && !company.paid}
					<div
						class="mb-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-600/15 dark:bg-amber-900/20 dark:text-amber-100 dark:ring-amber-400/20"
						role="status"
						data-testid="cloud-unpaid"
					>
						{#if company.role === 'admin'}
							{tp('shell.unpaidAdmin', { name: company.name })}
							<a href="/einstellungen/cloud" class="font-medium underline">{t('shell.unpaidSubscribe')}</a>
						{:else}
							{tp('shell.unpaidMember', { name: company.name })}
						{/if}
					</div>
				{/if}
				<!-- Cloud: the "Neue Änderungen" pill bumps presence.reload; remounting reloads the page's data. -->
				{#key presence.reload}
					{#if forbidden}
						<EmptyState title={t('access.forbiddenTitle')} hint={t('access.forbiddenHint')} icon="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
					{:else}
						{@render children()}
					{/if}
				{/key}
			</div>
		</main>

		<!-- Mobile bottom navigation: frosted, fixed over content. -->
		<nav
			class="fixed bottom-0 left-0 right-0 z-50 flex h-16 items-center justify-around border-t border-zinc-900/5 bg-white/75 backdrop-blur-xl backdrop-saturate-150 md:hidden dark:border-white/10 dark:bg-zinc-900/75"
		>
			{#each visibleNav as item, i (item.href)}
				<a
					href={item.href}
					aria-current={i === activeIndex ? 'page' : undefined}
					class="relative flex flex-col items-center gap-0.5 px-1 py-1 text-center transition-colors duration-200 {i === activeIndex
						? 'text-accent-600 dark:text-accent-400'
						: 'text-zinc-500 dark:text-zinc-400'}"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
					</svg>
					<span class="text-[10px] leading-tight">{item.shortLabel}</span>
					<span
						class="absolute -bottom-1 h-1 w-1 rounded-full bg-current transition-[transform,opacity] duration-300 ease-spring {i === activeIndex
							? 'scale-100 opacity-100'
							: 'scale-0 opacity-0'}"
					></span>
				</a>
			{/each}
		</nav>

		{#if switchingTo}
			<!-- Company switch: frosted full-window overlay until the reload lands. -->
			<div
				class="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-100/60 backdrop-blur-md dark:bg-zinc-950/60"
				role="status"
				aria-live="polite"
				transition:fade={{ duration: 200 }}
			>
				<div class="flex animate-pop items-center gap-3 rounded-2xl bg-white/90 px-5 py-3.5 text-sm font-medium shadow-float ring-1 ring-zinc-900/5 dark:bg-zinc-800/90 dark:ring-white/10">
					<svg class="h-4 w-4 animate-spin text-accent-600 dark:text-accent-400" fill="none" viewBox="0 0 24 24">
						<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" class="opacity-20" />
						<path d="M21 12a9 9 0 00-9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
					{tp('shell.switchingTo', { name: switchingTo })}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	/* Boot splash: slow breathing logo (global reduced-motion rule stills it). */
	.breathe {
		animation: breathe 2.4s cubic-bezier(0.37, 0, 0.63, 1) infinite;
	}
	@keyframes breathe {
		0%,
		100% {
			transform: scale(1);
			opacity: 0.85;
		}
		50% {
			transform: scale(1.05);
			opacity: 1;
		}
	}
</style>
