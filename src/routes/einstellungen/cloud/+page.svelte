<script lang="ts">
	import { onMount } from 'svelte';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import TextInput from '../../../common/TextInput.svelte';
	import Security from './Security.svelte';
	import { api, cloud, CloudError, keyringError, login, logout, publicApi, savedAccount, type Me } from '$lib/cloud';
	import { messageForUnknown } from '$lib/shared/errors';
	import { countsOf, pushImport, pushOrganization, pushReceipts, readLocalImport, SKIPPED, type ReceiptProgress } from '$lib/cloud-import';

	const MESSAGES: Record<string, string> = {
		invalid_credentials: 'E-Mail oder Passwort falsch.',
		email_unverified: 'E-Mail-Adresse noch nicht bestätigt. Wir haben den Link erneut gesendet.',
		invalid_code: '2FA-Code ungültig.',
		too_many_requests: 'Zu viele Versuche, bitte später erneut probieren.',
		session_expired: 'Sitzung abgelaufen, bitte neu anmelden.',
		invalid_input: 'Bitte E-Mail und Name korrekt angeben.',
		password_length_12_to_128: 'Das Passwort muss 12 bis 128 Zeichen lang sein.',
		admin_only: 'Nur Firmen-Admins können das Abo verwalten.',
		no_subscription: 'Für diese Firma gibt es noch kein Abo.',
		already_subscribed: 'Für diese Firma besteht bereits ein Abo.',
		totp_already_enabled: '2FA ist bereits aktiv.',
		totp_not_enabled: '2FA ist nicht aktiv.',
		company_not_empty:
			'Diese Cloud-Firma enthält bereits Daten. Die Übertragung ist nur in eine leere Firma möglich.'
	};
	const message = (e: unknown) =>
		(e instanceof CloudError && MESSAGES[e.code]) || messageForUnknown(e);

	const initial = cloud();
	const saved = initial ?? savedAccount();
	let session = $state(initial);
	let mode = $state<'login' | 'register' | 'forgot'>('login');
	let url = $state(saved?.url ?? 'https://bookie.logscale-it.com');
	let email = $state(saved?.email ?? '');
	let name = $state('');
	let password = $state('');
	let notice = $state('');
	let code = $state('');
	let needsCode = $state(false);
	let companyName = $state('');
	let me = $state<Me | null>(null);
	let busy = $state(false);
	let error = $state(
		!initial && keyringError ? 'Schlüsselbund nicht erreichbar: Sitzung nicht geladen, bitte erneut anmelden.' : ''
	);

	const active = $derived(me?.companies.find((c) => c.id === me?.activeCompanyId));

	onMount(async () => {
		if (session) await run(loadMe);
	});

	const loadMe = async () => {
		me = await api<Me>('/me');
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
				needsCode = true;
				return;
			}
			// A fresh sign-in always offers the import again (ids of another server
			// must not suppress it); the server refuses a non-empty company anyway.
			localStorage.removeItem(IMPORTED);
			location.reload();
		});

	const register = () =>
		run(async () => {
			await publicApi(url, '/auth/register', { email, name, password });
			password = '';
			mode = 'login';
			notice =
				'Fast geschafft: Bitte bestätige deine E-Mail über den Link, den wir dir geschickt haben, und melde dich dann an.';
		});

	const forgot = () =>
		run(async () => {
			await publicApi(url, '/auth/password/forgot', { email });
			mode = 'login';
			notice =
				'Falls ein Konto zu dieser Adresse existiert, haben wir dir einen Link zum Zurücksetzen des Passworts geschickt.';
		});

	const switchMode = (m: typeof mode) => ((mode = m), (notice = error = ''));

	const signOut = () => run(async () => (await logout(), location.reload()));

	const createCompany = () =>
		run(async () => {
			await api('/companies', 'POST', { name: companyName });
			me = await api<Me>('/me');
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
		const text =
			`Einmalig in die Cloud-Firma „${target.name}“ übertragen:\n` +
			`${c.customers} Kunden, ${c.projects} Projekte, ${c.time_entries} Zeiteinträge, ` +
			`${c.invoices} Rechnungen, ${c.incoming_invoices} Eingangsrechnungen, ${c.recurring_entries} wiederkehrende Buchungen, ` +
			`${c.vat_taxes} MwSt-Sätze, Firmenstammdaten und die Rechnungseinstellungen.\n\n` +
			'Nur in eine leere Cloud-Firma möglich und nicht wiederholbar. Ausgestellte Rechnungen ' +
			'behalten Nummer und Beträge; Zeiteinträge werden dir zugeordnet und sind nicht freigegeben. ' +
			'Die lokale Datei bleibt unverändert.\n\n' +
			`Nicht übertragen:\n- ${SKIPPED.join('\n- ')}`;
		if (!auto && !confirm(text)) return;
		try {
			const r = await pushImport(doc);
			await pushOrganization();
			notice = `Lokale Daten übertragen: ${r.customers} Kunden, ${r.projects} Projekte, ${r.time_entries} Zeiteinträge, ${r.invoices} Rechnungen, ${r.incoming_invoices} Eingangsrechnungen, ${r.recurring_entries} wiederkehrende Buchungen. Nicht übertragen: ${SKIPPED.join(', ')}.`;
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
		const done = `${r.done} Belegdateien übertragen.`;
		notice = notice ? `${notice} ${done}` : done;
		if (r.failed.length) error = `Nicht übertragen (bitte von Hand anhängen):\n${r.failed.join('\n')}`;
	}

	// Back from the Stripe page in the browser: pick up the new subscription status.
	const onFocus = () => {
		if (session && !busy) loadMe().catch(() => (session = cloud()));
	};
</script>

<svelte:window onfocus={onFocus} />

<section class="card space-y-4">
	<h2 class="text-base font-semibold">bookie Cloud</h2>
	<p class="text-sm text-zinc-500 dark:text-zinc-400">
		Angemeldet speichert bookie Firma, Kunden, Projekte und Zeiten auf dem Server, damit dein Team
		gemeinsam daran arbeiten kann. Die übrigen Bereiche folgen; bis dahin sind sie im Cloud-Modus
		gesperrt. Deine lokalen Daten bleiben unverändert auf diesem Gerät und sind nach dem Abmelden
		wieder da.
	</p>

	{#if !session}
		<div class="grid gap-3 md:grid-cols-2">
			<TextInput bind:value={url} label="Server" placeholder="https://bookie.logscale-it.com" />
			<TextInput bind:value={email} label="E-Mail" type="email" />
			{#if mode === 'register'}
				<TextInput bind:value={name} label="Name" />
			{/if}
			{#if mode !== 'forgot'}
				<TextInput
					bind:value={password}
					label={mode === 'register' ? 'Passwort (mind. 12 Zeichen)' : 'Passwort'}
					type="password"
				/>
			{/if}
			{#if mode === 'login' && needsCode}
				<TextInput bind:value={code} label="2FA-Code oder Wiederherstellungscode" />
			{/if}
		</div>
		<div class="flex flex-wrap items-center gap-3">
			{#if mode === 'login'}
				<button class="btn-primary" onclick={signIn} disabled={busy || !url || !email || !password}>
					Anmelden
				</button>
				<button class="btn-secondary" onclick={() => switchMode('register')}>Konto erstellen</button>
				<button class="btn-secondary" onclick={() => switchMode('forgot')}>
					Passwort vergessen?
				</button>
			{:else if mode === 'register'}
				<button
					class="btn-primary"
					onclick={register}
					disabled={busy || !url || !email || !name.trim() || password.length < 12}
				>
					Registrieren
				</button>
				<button class="btn-secondary" onclick={() => switchMode('login')}>Zurück</button>
			{:else}
				<button class="btn-primary" onclick={forgot} disabled={busy || !url || !email}>
					Link zum Zurücksetzen senden
				</button>
				<button class="btn-secondary" onclick={() => switchMode('login')}>Zurück</button>
			{/if}
		</div>
	{:else}
		<p class="text-sm">Angemeldet als <strong>{session.email}</strong> bei {session.url}</p>
		{#if me && !active}
			<div class="flex flex-wrap items-end gap-3">
				<TextInput bind:value={companyName} label="Firma anlegen" />
				<button class="btn-primary" onclick={createCompany} disabled={busy || !companyName.trim()}>
					Anlegen
				</button>
			</div>
		{:else if me && active}
			{#if me.companies.length > 1}
				<div class="flex flex-col gap-1">
					<label for="cloud-company" class="label">Firma wechseln</label>
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
				Firma: <strong>{active.name}</strong> ·
				{active.paid ? 'Abo aktiv' : 'Kein aktives Abo'}
			</p>
			<div class="flex flex-wrap gap-3">
				{#if active.role === 'admin'}
					{#if active.paid}
						<button
							class="btn-secondary"
							onclick={() => openBilling('/billing/portal')}
							disabled={busy}
						>
							Abo verwalten
						</button>
					{:else}
						<button
							class="btn-primary"
							onclick={() => openBilling('/billing/checkout')}
							disabled={busy}
						>
							Abo abschließen
						</button>
					{/if}
				{/if}
				<button class="btn-secondary" onclick={() => run(loadMe)} disabled={busy}>
					Status aktualisieren
				</button>
			</div>
			{#if active.role === 'admin' && active.paid && imported.includes(active.id)}
				<div class="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
					<p class="text-sm text-zinc-500 dark:text-zinc-400">
						Belegdateien der übertragenen Eingangsrechnungen (lokaler S3-Speicher oder Festplatte)
						an die Cloud-Einträge anhängen, die noch keinen Beleg haben.
					</p>
					<button class="btn-secondary" onclick={() => run(transferReceipts)} disabled={busy}>
						Belege übertragen
					</button>
				</div>
			{/if}
			{#if active.role === 'admin' && active.paid && !imported.includes(active.id)}
				<div class="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
					<h3 class="text-sm font-semibold">Lokale Daten in die Cloud übertragen</h3>
					<p class="text-sm text-zinc-500 dark:text-zinc-400">
						Einmalig: Kunden, Projekte, Zeiten, Rechnungen und Einstellungen von diesem Gerät in
						diese noch leere Cloud-Firma kopieren. Die lokale Datei bleibt unverändert.
					</p>
					<button class="btn-secondary" onclick={() => transfer(active)} disabled={busy}>
						Lokale Daten übertragen
					</button>
				</div>
			{/if}
		{/if}
		{#if me}<Security bind:me {busy} {run} />{/if}
		<button class="btn-secondary" onclick={signOut} disabled={busy}>Abmelden</button>
	{/if}

	{#if progress}
		<div class="space-y-1">
			<p class="text-xs">
				Belege übertragen: {progress.done} / {progress.total}
			</p>
			<progress class="w-full" value={progress.done} max={progress.total || 1}></progress>
		</div>
	{/if}
	{#if notice}<p class="text-xs text-green-600 dark:text-green-400">{notice}</p>{/if}
	{#if error}<p class="whitespace-pre-line text-xs text-red-600">{error}</p>{/if}
</section>
