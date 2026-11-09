<script lang="ts">
	import { refreshMe } from '$lib/session.svelte';
	import { onMount } from 'svelte';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import TextInput from '../../../common/TextInput.svelte';
	import Security from './Security.svelte';
	import { api, cloud, CloudError, keyringError, login, logout, publicApi, savedAccount, type Me } from '$lib/cloud';
	import { messageForUnknown } from '$lib/shared/errors';
	import { acceptInvitation } from '$lib/team';
	import { getLocaleFormatting, t, tp } from '$lib/i18n';
	import { countsOf, pushImport, pushOrganization, pushReceipts, readLocalImport, skipped, type ReceiptProgress } from '$lib/cloud-import';

	// Server error codes with a cloudSettings.errors.<code> text; t() returns the key itself when missing.
	const message = (e: unknown) => {
		const k = e instanceof CloudError ? `cloudSettings.errors.${e.code}` : '';
		return (k && t(k) !== k && t(k)) || messageForUnknown(e);
	};

	const initial = cloud();
	const saved = initial ?? savedAccount();
	let session = $state(initial);
	// verify: registered, waiting for the mail link; signs in by itself on return.
	// ?neu=1 (cloud teasers on Team / Urlaub, settings card) opens the signup.
	let mode = $state<'login' | 'register' | 'forgot' | 'verify'>('login');
	const DEFAULT_URL = 'https://bookie.logscale-it.com';
	let url = $state(saved?.url ?? DEFAULT_URL);
	// Self-hosted / test servers only: hidden unless asked for or already in use.
	let customServer = $state((saved?.url ?? DEFAULT_URL) !== DEFAULT_URL);
	let email = $state(saved?.email ?? '');
	let name = $state('');
	let password = $state('');
	let password2 = $state('');
	let notice = $state('');
	let code = $state('');
	let needsCode = $state(false);
	let companyName = $state('');
	let terms = $state(false);
	let inviteToken = $state('');
	let me = $state<Me | null>(null);
	let busy = $state(false);
	let error = $state(
		!initial && keyringError ? t('cloudSettings.keyringError') : ''
	);

	const active = $derived(me?.companies.find((c) => c.id === me?.activeCompanyId));

	onMount(async () => {
		if (!session && new URLSearchParams(location.search).has('neu')) mode = 'register'; // not at prerender
		if (session) await run(loadMe);
	});

	const loadMe = async () => {
		me = await refreshMe();
		const a = me.companies.find((c) => c.id === me?.activeCompanyId);
		// Switching to the cloud moves the local data along: automatically into the first
		// paid company this device administers (the button covers any further company).
		if (a?.role === 'admin' && a.paid && !imported.length) await importLocal(a, true);
	};

	async function run(fn: () => Promise<unknown>) {
		busy = true;
		error = '';
		try {
			await fn();
		} catch (e) {
			error = message(e);
			session = cloud(); // a 401 cleared it: back to the login form
		} finally {
			busy = false;
		}
	}

	// Every page loads its data on mount, so a mode switch reloads the app.
	const signIn = () =>
		run(async () => {
			if ((await login(url, email, password, needsCode ? code : undefined)) === 'mfa') {
				mode = 'login';
				needsCode = true;
				return;
			}
			// A fresh sign-in always offers the import again (ids of another server
			// must not suppress it); the server refuses a non-empty company anyway.
			localStorage.removeItem(IMPORTED);
			location.reload();
		});

	// The company (with the 14-day trial) is set up by the server at the first sign-in.
	const register = () =>
		run(async () => {
			await publicApi(url, '/auth/register', {
				email,
				name,
				password,
				...(companyName.trim() ? { company: companyName.trim(), terms } : {})
			});
			password2 = '';
			mode = 'verify';
			notice = '';
		});
	// Back from the browser after clicking the mail link: try quietly, stay put while unverified.
	async function verifiedYet() {
		try {
			if ((await login(url, email, password)) === 'mfa') return void (mode = 'login', (needsCode = true));
			localStorage.removeItem(IMPORTED);
			location.reload();
		} catch {
			// still unverified (or offline): the button retries with a visible error
		}
	}

	const forgot = () =>
		run(async () => {
			await publicApi(url, '/auth/password/forgot', { email });
			mode = 'login';
			notice = t('cloudSettings.resetSent');
		});

	const switchMode = (m: typeof mode) => ((mode = m), (notice = error = ''));

	const signOut = () => run(async () => (await logout(), location.reload()));

	const createCompany = () =>
		run(async () => {
			await api('/companies', 'POST', { name: companyName, terms });
			me = await refreshMe();
			if (active?.paid) await importLocal(active, true); // trial: move the local data in right away
		});
	// Open invitations to this address (from /me): join without pasting the mail link.
	const joinInvited = (id: number) =>
		run(async () => {
			await api('/api/invitations/accept', 'POST', { id });
			location.reload();
		});
	const legal = (path: string) => openUrl(`${url.replace(/\/+$/, '')}${path}`);
	const trialEnd = (iso: string) => new Date(iso).toLocaleDateString(getLocaleFormatting());

	// The server switches the session to the invited company: reload like a company switch.
	const acceptInvite = () =>
		run(async () => {
			await acceptInvitation(inviteToken);
			location.reload();
		});

	// Every page loads its data on mount, so a company switch reloads the app.
	const switchCompany = (companyId: number) =>
		run(async () => {
			await api('/session/company', 'POST', { companyId });
			location.reload();
		});

	const openBilling = (path: '/billing/checkout' | '/billing/portal') =>
		run(async () => openUrl((await api<{ url: string }>(path, 'POST', {})).url));

	// Local → cloud import, offered once per cloud company (admin, paid).
	// shortcut: "already imported" is per device and reset on every sign-in, so a second device auto-imports into the next empty paid company; move it to the server if users run several devices.
	const IMPORTED = 'bookie.cloud.imported';
	const readImported = (): number[] => {
		try {
			return JSON.parse(localStorage.getItem(IMPORTED) ?? '[]');
		} catch {
			return [];
		}
	};
	let imported = $state(readImported());
	const markImported = (id: number) => {
		imported = [...imported, id];
		try {
			localStorage.setItem(IMPORTED, JSON.stringify(imported));
		} catch {
			// only hides the section; the server refuses a second import anyway
		}
	};

	async function importLocal(target: { id: number; name: string }, auto: boolean) {
		const doc = await readLocalImport();
		const c = countsOf(doc);
		const { vat_taxes, ...data } = c; // VAT rates are seeded locally, they alone are no data
		if (auto && !Object.values(data).some(Boolean)) return;
		const text = tp('cloudSettings.importConfirm', {
			name: target.name,
			customers: c.customers,
			projects: c.projects,
			time_entries: c.time_entries,
			invoices: c.invoices,
			incoming: c.incoming_invoices,
			recurring: c.recurring_entries,
			vat: c.vat_taxes,
			skipped: skipped().join('\n- ')
		});
		if (!auto && !confirm(text)) return;
		try {
			const r = await pushImport(doc);
			await pushOrganization();
			notice = tp('cloudSettings.imported', {
				customers: r.customers,
				projects: r.projects,
				time_entries: r.time_entries,
				invoices: r.invoices,
				incoming: r.incoming_invoices,
				recurring: r.recurring_entries,
				skipped: skipped().join(', ')
			});
			await transferReceipts().catch((e) => (error = message(e))); // the import itself went through
		} catch (e) {
			const filled = e instanceof CloudError && e.code === 'company_not_empty';
			// Auto: a failure must not block loading /me; the button stays for a retry.
			if (auto && !filled) return void (error = message(e));
			if (!filled) throw e;
			if (!auto) error = message(e);
		}
		markImported(target.id);
	}

	const transfer = (target: { id: number; name: string }) => run(() => importLocal(target, false));

	// Receipt files after the import; repeatable, it only fills cloud rows without a receipt.
	let progress = $state<ReceiptProgress | null>(null);
	async function transferReceipts() {
		const r = await pushReceipts((p) => (progress = p)).finally(() => (progress = null));
		const done = tp('cloudSettings.receiptsDone', { count: r.done });
		notice = notice ? `${notice} ${done}` : done;
		if (r.failed.length) error = tp('cloudSettings.receiptsFailed', { list: r.failed.join('\n') });
	}

	// Back from the Stripe page in the browser: pick up the new subscription status.
	const onFocus = () => {
		if (!session && mode === 'verify' && !busy) void verifiedYet();
		if (session && !busy) loadMe().catch(() => (session = cloud()));
	};
</script>

<svelte:window onfocus={onFocus} />

{#snippet termsBox()}
	<label class="flex items-start gap-2 text-sm">
		<input type="checkbox" class="mt-1" bind:checked={terms} />
		<span>
			{t('cloudSettings.termsLead')}
			<button type="button" class="text-accent-600 hover:underline dark:text-accent-400" onclick={() => legal('/agb')}>{t('cloudSettings.termsAgb')}</button>
			{t('cloudSettings.termsAnd')}
			<button type="button" class="text-accent-600 hover:underline dark:text-accent-400" onclick={() => legal('/avv')}>{t('cloudSettings.termsAvv')}</button>.
		</span>
	</label>
{/snippet}

<section class="card space-y-4">
	<h2 class="text-base font-semibold">bookie Cloud</h2>
	<p class="text-sm text-zinc-500 dark:text-zinc-400">
		{t('cloudSettings.intro')}
	</p>

	{#if !session && mode === 'verify'}
		<div class="space-y-3">
			<p class="text-sm">
				{t('cloudSettings.verifyLead')} <strong>{email}</strong>
				{t('cloudSettings.verifyRest')}
			</p>
			<div class="flex flex-wrap gap-3">
				<button class="btn-primary" onclick={signIn} disabled={busy}>{t('cloudSettings.confirmed')}</button>
				<button class="btn-secondary" onclick={() => switchMode('login')}>{t('common.back')}</button>
			</div>
		</div>
	{:else if !session}
		{#if mode === 'register'}
			<div class="rounded-lg bg-accent-500/10 p-3 text-sm ring-1 ring-accent-600/15">
				<strong>{t('cloudSettings.trialStrong')}</strong>{t('cloudSettings.trialRest')}
			</div>
		{/if}
		<div class="grid gap-3 md:grid-cols-2">
			{#if mode === 'register'}
				<TextInput bind:value={companyName} label={t('cloudSettings.company')} placeholder={t('cloudSettings.companyPlaceholder')} />
				<TextInput bind:value={name} label={t('common.name')} />
			{/if}
			<TextInput bind:value={email} label={t('cloudSettings.email')} type="email" />
			{#if mode !== 'forgot'}
				<TextInput
					bind:value={password}
					label={mode === 'register' ? t('cloudSettings.passwordMin') : t('security.password')}
					type="password"
				/>
			{/if}
			{#if mode === 'register'}
				<TextInput bind:value={password2} label={t('cloudSettings.passwordRepeat')} type="password" />
				{#if password2 && password2 !== password}
					<p class="text-sm text-red-600 md:col-span-2">{t('cloudSettings.passwordMismatch')}</p>
				{/if}
			{/if}
			{#if mode === 'login' && needsCode}
				<TextInput bind:value={code} label={t('security.codeOrRecovery')} />
			{/if}
		</div>
		{#if mode === 'register' && companyName.trim()}
			{@render termsBox()}
		{/if}
		{#if customServer}
			<div class="max-w-md">
				<TextInput bind:value={url} label="Server" placeholder={DEFAULT_URL} />
			</div>
		{:else}
			<button
				type="button"
				class="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
				onclick={() => (customServer = true)}
			>
				{t('cloudSettings.customServer')}
			</button>
		{/if}
		<div class="flex flex-wrap items-center gap-3">
			{#if mode === 'login'}
				<button class="btn-primary" onclick={signIn} disabled={busy || !url || !email || !password}>
					{t('cloudSettings.signIn')}
				</button>
				<button class="btn-secondary" onclick={() => switchMode('register')}>{t('cloudSettings.createAccount')}</button>
				<button class="btn-secondary" onclick={() => switchMode('forgot')}>
					{t('cloudSettings.forgotPassword')}
				</button>
			{:else if mode === 'register'}
				<button
					class="btn-primary"
					onclick={register}
					disabled={busy ||
						!url ||
						!email ||
						!name.trim() ||
						password.length < 12 ||
						password !== password2 ||
						(!!companyName.trim() && !terms)}
				>
					{t('cloudSettings.register')}
				</button>
				<button class="btn-secondary" onclick={() => switchMode('login')}>{t('common.back')}</button>
			{:else}
				<button class="btn-primary" onclick={forgot} disabled={busy || !url || !email}>
					{t('cloudSettings.sendReset')}
				</button>
				<button class="btn-secondary" onclick={() => switchMode('login')}>{t('common.back')}</button>
			{/if}
		</div>
	{:else}
		<p class="text-sm">{t('cloudSettings.signedInAs')} <strong>{session.email}</strong> {tp('cloudSettings.signedInAt', { url: session.url })}</p>
		{#if me?.invitations?.length}
			<div class="space-y-2 rounded-lg bg-accent-500/10 p-3 ring-1 ring-accent-600/15">
				<h3 class="text-sm font-semibold">{t('cloudSettings.openInvitations')}</h3>
				{#each me.invitations as inv (inv.id)}
					<div class="flex flex-wrap items-center justify-between gap-3" data-testid="invitation-row">
						<span class="text-sm">
							<strong>{inv.company}</strong> · {t(inv.role === 'subcontractor' ? 'shell.roleSubcontractor' : 'shell.roleMember')}
						</span>
						<button class="btn-primary" onclick={() => joinInvited(inv.id)} disabled={busy}>
							{t('cloudSettings.join')}
						</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if me && !active}
			<div class="flex flex-wrap items-end gap-3">
				<TextInput bind:value={companyName} label={t('cloudSettings.createCompany')} />
				<button
					class="btn-primary"
					onclick={createCompany}
					disabled={busy || !companyName.trim() || !terms}
				>
					{t('cloudSettings.create')}
				</button>
			</div>
			{@render termsBox()}
			<p class="text-sm text-zinc-500 dark:text-zinc-400">
				{t('cloudSettings.newCompanyTrial')}
			</p>
			<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('cloudSettings.orJoin')}</p>
			<div class="flex flex-wrap items-end gap-3">
				<TextInput bind:value={inviteToken} label={t('cloudSettings.inviteToken')} />
				<button class="btn-primary" onclick={acceptInvite} disabled={busy || !inviteToken.trim()}>
					{t('cloudSettings.accept')}
				</button>
			</div>
		{:else if me && active}
			{#if me.companies.length > 1}
				<div class="flex flex-col gap-1">
					<label for="cloud-company" class="label">{t('cloudSettings.switchCompany')}</label>
					<select
						id="cloud-company"
						class="input-base input-valid"
						value={active.id}
						disabled={busy}
						onchange={(e) => switchCompany(Number(e.currentTarget.value))}
					>
						{#each me.companies as c (c.id)}
							<option value={c.id}>{c.name}</option>
						{/each}
					</select>
				</div>
			{/if}
			<p class="text-sm">
				{t('cloudSettings.companyLabel')} <strong>{active.name}</strong> ·
				{active.trialEndsAt
					? tp('cloudSettings.trialUntil', { date: trialEnd(active.trialEndsAt) })
					: active.paid
						? t('cloudSettings.subscriptionActive')
						: t('cloudSettings.noSubscription')}{#if me.active}
					· {tp(me.active.seats === 1 ? 'cloudSettings.seat' : 'cloudSettings.seats', { n: me.active.seats })}{/if}
			</p>
			<div class="flex flex-wrap gap-3">
				{#if active.role === 'admin'}
					{#if active.paid && !active.trialEndsAt}
						<button
							class="btn-secondary"
							onclick={() => openBilling('/billing/portal')}
							disabled={busy}
						>
							{t('cloudSettings.manageSubscription')}
						</button>
					{:else}
						<button
							class="btn-primary"
							onclick={() => openBilling('/billing/checkout')}
							disabled={busy}
						>
							{t('cloudSettings.subscribe')}
						</button>
					{/if}
				{/if}
				<button class="btn-secondary" onclick={() => run(loadMe)} disabled={busy}>
					{t('cloudSettings.refreshStatus')}
				</button>
			</div>
			{#if active.role === 'admin' && active.paid && imported.includes(active.id)}
				<div class="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
					<p class="text-sm text-zinc-500 dark:text-zinc-400">
						{t('cloudSettings.receiptsNote')}
					</p>
					<button class="btn-secondary" onclick={() => run(transferReceipts)} disabled={busy}>
						{t('cloudSettings.transferReceipts')}
					</button>
				</div>
			{/if}
			{#if active.role === 'admin' && active.paid && !imported.includes(active.id)}
				<div class="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
					<h3 class="text-sm font-semibold">{t('cloudSettings.importTitle')}</h3>
					<p class="text-sm text-zinc-500 dark:text-zinc-400">
						{t('cloudSettings.importNote')}
					</p>
					<button class="btn-secondary" onclick={() => transfer(active)} disabled={busy}>
						{t('cloudSettings.importButton')}
					</button>
				</div>
			{/if}
		{/if}
		{#if me}<Security bind:me {busy} {run} />{/if}
		<button class="btn-secondary" onclick={signOut} disabled={busy}>{t('cloudSettings.signOut')}</button>
	{/if}

	{#if progress}
		<div class="space-y-1">
			<p class="text-xs">
				{tp('cloudSettings.receiptsProgress', { done: progress.done, total: progress.total })}
			</p>
			<progress class="w-full" value={progress.done} max={progress.total || 1}></progress>
		</div>
	{/if}
	{#if notice}<p class="text-xs text-green-600 dark:text-green-400">{notice}</p>{/if}
	{#if error}<p class="whitespace-pre-line text-xs text-red-600">{error}</p>{/if}
</section>
