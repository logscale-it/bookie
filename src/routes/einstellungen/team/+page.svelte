<script lang="ts">
	import { refreshMe } from '$lib/session.svelte';
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import CloudWorkContext from '../../../common/CloudWorkContext.svelte';
	import { cloud, CloudError, type Me } from '$lib/cloud';
	import { formatCents } from '$lib/shared/money';
	import { messageForUnknown } from '$lib/shared/errors';
	import * as team from '$lib/team';
	import Dialog from '../../../common/Dialog.svelte';
	import SectionHead from '../SectionHead.svelte';
	import { deferDelete } from '$lib/ui/undo';

	const MESSAGES: Record<string, string> = {
		invalid_input: 'Eingabe ungültig.',
		invalid_token: 'Einladung ungültig oder abgelaufen.',
		wrong_account: 'Die Einladung gilt für eine andere E-Mail-Adresse.',
		already_member: 'Du bist bereits Mitglied dieser Firma.',
		too_many_requests: 'Zu viele Einladungen heute, bitte später erneut probieren.',
		rejected: 'Zuweisung nicht möglich.',
		not_found: 'Nicht gefunden.',
		no_grants_for_role: 'Admin und Subunternehmer erhalten keine Bereichsrechte.',
		not_a_member: 'Nur Mitglieder (keine Subunternehmer) können Admin werden.'
	};
	const message = (e: unknown) =>
		(e instanceof CloudError && MESSAGES[e.code]) || messageForUnknown(e);
	const ROLES: Record<team.Role, string> = {
		admin: 'Admin',
		member: 'Mitglied',
		subcontractor: 'Subunternehmer'
	};
	const AREA_LABELS: Record<team.Area, string> = {
		invoices: 'Rechnungen',
		incoming_invoices: 'Eingangsrechnungen',
		reports: 'Berichte',
		recurring: 'Wiederkehrend',
		team_time: 'Team-Zeiten',
		settings: 'Einstellungen'
	};
	type GrantLevel = '' | team.Grant['level'];
	const eur = (cents: number | null) => (cents == null ? '' : String(cents / 100).replace('.', ','));
	const day = (iso: string) => new Date(iso).toLocaleDateString('de-DE');
	const INVITE_STATUS: Record<team.Invitation['status'], [string, string]> = {
		pending: ['Offen', 'badge-amber'],
		accepted: ['Angenommen', 'badge-green'],
		expired: ['Abgelaufen', 'badge-zinc']
	};

	const session = cloud();
	let me = $state<Me | null>(null);
	let members = $state<team.TeamMember[]>([]);
	let invitations = $state<team.Invitation[]>([]);
	let rates = $state<Record<number, string>>({});
	let grants = $state<Record<number, Record<team.Area, GrantLevel>>>({});
	let inviteEmail = $state('');
	let inviteRole = $state<'member' | 'subcontractor'>('member');
	let inviteRate = $state('');
	let invitePreset = $state('member');
	let token = $state('');
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	// Consequential team changes (billing, rights, admin handover) confirm in a dialog.
	let ask = $state<{ title: string; body: string; label: string; danger?: boolean; ok: () => void; cancel?: () => void } | null>(null);
	const closeAsk = () => {
		ask?.cancel?.();
		ask = null;
	};

	const active = $derived(me?.companies.find((c) => c.id === me?.activeCompanyId));
	const admin = $derived(active?.role === 'admin');
	const pending = $derived(invitations.filter((i) => i.status === 'pending').length);
	const subs = $derived(members.filter((m) => m.role === 'subcontractor'));

	onMount(() => session && run(load));

	async function load() {
		me = await refreshMe();
		if (active?.role !== 'admin') return;
		members = await team.listMembers();
		invitations = await team.listInvitations();
		rates = Object.fromEntries(members.map((m) => [m.user_id, eur(m.cost_rate_cents)]));
		grants = Object.fromEntries(
			members.map((m) => [
				m.user_id,
				Object.fromEntries(
					team.AREAS.map((a) => [a, m.grants.find((g) => g.area === a)?.level ?? ''])
				) as Record<team.Area, GrantLevel>
			])
		);
	}

	async function run(fn: () => Promise<unknown>, done = '') {
		busy = true;
		error = notice = '';
		try {
			await fn();
			notice = done;
		} catch (e) {
			error = message(e);
		} finally {
			busy = false;
		}
	}

	const sendInvite = () =>
		run(async () => {
			await team.invite(inviteEmail.trim(), inviteRole, inviteRate, team.PRESETS[invitePreset].grants);
			inviteEmail = inviteRate = '';
			invitations = await team.listInvitations();
		}, 'Einladung gesendet.');

	const revoke = (i: team.Invitation) => {
		const before = invitations;
		deferDelete({
			message: `Einladung an ${i.email} ${i.status === 'pending' ? 'widerrufen' : 'entfernt'}`,
			hide: () => (invitations = invitations.filter((x) => x.id !== i.id)),
			restore: () => (invitations = before),
			run: () => team.revokeInvitation(i.id),
			onDone: () => team.listInvitations().then((r) => (invitations = r))
		});
	};

	// The server switches the session to the new company: reload like a company switch.
	const accept = () =>
		run(async () => {
			await team.acceptInvitation(token);
			location.reload();
		});

	const saveRate = (userId: number) =>
		run(async () => {
			await team.setCostRate(userId, rates[userId]);
			await load();
		}, 'Kostensatz gespeichert.');

	const saveGrants = (userId: number) =>
		run(async () => {
			const g = grants[userId];
			await team.setGrants(
				userId,
				team.AREAS.flatMap((area) => (g[area] ? [{ area, level: g[area] }] : []))
			);
			await load();
		}, 'Rechte gespeichert.');

	const changeRole = (m: team.TeamMember, select: HTMLSelectElement) => {
		const role = select.value as 'member' | 'subcontractor';
		const go = () =>
			run(async () => {
				await team.setRole(m.user_id, role);
				await load();
			}, 'Rolle geändert.');
		if (role === 'subcontractor' && m.grants.length > 0) {
			ask = {
				title: 'Rolle ändern',
				body: `${m.name} wird Subunternehmer und verliert alle Bereichsrechte.`,
				label: 'Rolle ändern',
				ok: go,
				cancel: () => (select.value = m.role)
			};
			return;
		}
		go();
	};

	// Admin moves to the other member; this page then shows the member view.
	const handOver = (m: team.TeamMember) => {
		ask = {
			title: 'Admin übergeben',
			body: `${m.name} wird Admin von ${active?.name} (Abo, Team, alle Bereiche). Du bleibst Mitglied mit Bearbeitungsrechten in allen Bereichen.`,
			label: 'Zum Admin machen',
			ok: () =>
				run(async () => {
					await team.makeAdmin(m.user_id);
					location.reload();
				})
		};
	};

	const remove = (m: team.TeamMember) => {
		ask = {
			title: 'Mitglied entfernen',
			body: `${m.name} aus der Firma entfernen? Der Platz wird anteilig aus deinem Abo genommen.`,
			label: 'Entfernen',
			danger: true,
			ok: () =>
				run(async () => {
					await team.removeMember(m.user_id);
					await load();
				}, 'Mitglied entfernt.')
		};
	};

</script>

{#if !session}
	<section class="card">
		<p class="text-sm">Die Teamverwaltung ist nur mit bookie Cloud verfügbar.</p>
	</section>
{:else}
	<div class="space-y-6">
		{#if error}<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-600/10 dark:bg-red-950/40 dark:text-red-300">{error}</p>{/if}
		{#if notice}<p class="animate-pop rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-600/10 dark:bg-emerald-950/40 dark:text-emerald-300">{notice}</p>{/if}

		{#if active && !admin}
			<CloudWorkContext />
		{/if}

		{#if admin}
			<section class="card space-y-3 p-5" data-testid="team-seats">
				<SectionHead eyebrow="Abo" title="Lizenzen" />
				<p class="text-sm">
					<strong>{members.length} {members.length === 1 ? 'Platz' : 'Plätze'}</strong> im Abo von
					{active?.name}: {members.filter((m) => m.role === 'admin').length} Admin,
					{members.filter((m) => m.role === 'member').length} Mitglieder, {subs.length} Subunternehmer.
				</p>
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					Jedes Mitglied, auch jeder Subunternehmer, ist ein bezahlter Platz in deinem Abo. Nimmt
					jemand eine Einladung an oder wird entfernt, passt bookie die Anzahl automatisch an und
					rechnet anteilig ab. Offene Einladungen ({pending}) kosten nichts. Abo und Rechnungen:
					<a class="font-medium text-accent-600 hover:underline dark:text-accent-400" href="/einstellungen/cloud">Einstellungen → Konto & Abo</a>.
				</p>
			</section>
		{/if}

		{#if active && active.role !== 'subcontractor'}
			<section class="card space-y-3 p-5">
				<SectionHead eyebrow="Zeiten" title="Stunden & Freigaben" />
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					Stunden je Person, Monatsfreigaben und die Team-Aktivität stehen unter
					<a class="font-medium text-accent-600 hover:underline dark:text-accent-400" href="/team">Team</a>. Wer an welchem Projekt arbeitet, legst du unter
					<a class="font-medium text-accent-600 hover:underline dark:text-accent-400" href="/projekte">Projekte</a> fest (Subunternehmer sehen nur ihre Projekte).
				</p>
			</section>
		{/if}

		{#if admin}
			<section class="card space-y-4 p-5">
				<SectionHead eyebrow="Team" title="Mitglieder" desc="Rollen, Kostensätze und Bereichsrechte je Person." />
				<div class="table-scroll overflow-hidden rounded-lg ring-1 ring-zinc-900/5 dark:ring-white/10">
					<table class="w-full text-sm">
						<thead class="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
							<tr>
								<th class="px-3 py-2 text-left">Name</th>
								<th class="px-3 py-2 text-left">E-Mail</th>
								<th class="px-3 py-2 text-left">Rolle</th>
								<th class="px-3 py-2 text-left">Kostensatz (€/h)</th>
								<th class="px-3 py-2"></th>
							</tr>
						</thead>
						<tbody>
							{#each members as m (m.user_id)}
								<tr class="border-b border-zinc-100 text-zinc-700 transition duration-200 ease-spring hover:bg-zinc-50/70 dark:border-zinc-700/70 dark:text-zinc-200 dark:hover:bg-white/[0.02]">
									<td class="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">{m.name}</td>
									<td class="px-3 py-2">{m.email}</td>
									<td class="px-3 py-2">
										{#if m.role === 'admin'}
											<span class="badge badge-zinc">{ROLES[m.role]}</span>
										{:else}
											<select
												class="input-base input-valid rounded-lg py-1.5"
												aria-label="Rolle"
												disabled={busy}
												value={m.role}
												onchange={(e) => changeRole(m, e.currentTarget)}
											>
												<option value="member">{ROLES.member}</option>
												<option value="subcontractor">{ROLES.subcontractor}</option>
											</select>
										{/if}
									</td>
									<td class="px-3 py-2">
										{#if m.role === 'subcontractor'}
											<div class="flex gap-2">
												<input
													class="input-base input-valid w-28 rounded-lg py-1.5 tabular-nums"
													inputmode="decimal"
													aria-label="Kostensatz"
													bind:value={rates[m.user_id]}
												/>
												<button
													class="btn-secondary px-3 py-1.5 text-xs"
													disabled={busy}
													onclick={() => saveRate(m.user_id)}>Speichern</button
												>
											</div>
										{/if}
									</td>
									<td class="whitespace-nowrap px-3 py-2 text-right">
										{#if m.role === 'member'}
											<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => handOver(m)}
												>Zum Admin machen</button
											>
										{/if}
										{#if m.role !== 'admin'}
											<button class="icon-btn icon-btn-danger" disabled={busy} onclick={() => remove(m)} title="Entfernen" aria-label="{m.name} entfernen">
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" /></svg>
											</button>
										{/if}
									</td>
								</tr>
								{#if m.role === 'member' && grants[m.user_id]}
									<tr class="border-b border-zinc-100 bg-zinc-50/50 dark:border-zinc-700/70 dark:bg-white/[0.015]">
										<td colspan="5" class="px-3 py-3">
											<div class="flex flex-wrap items-end gap-3">
												{#each team.AREAS as area (area)}
													<div class="flex flex-col gap-1.5">
														<label for={`grant-${m.user_id}-${area}`} class="label"
															>{AREA_LABELS[area]}</label
														>
														<select
															id={`grant-${m.user_id}-${area}`}
															class="input-base input-valid rounded-lg py-1.5"
															bind:value={grants[m.user_id][area]}
														>
															<option value="">Kein Zugriff</option>
															<option value="view">Lesen</option>
															<option value="edit">Bearbeiten</option>
														</select>
													</div>
												{/each}
												<button
													class="btn-secondary px-3 py-1.5 text-xs"
													disabled={busy}
													onclick={() => saveGrants(m.user_id)}>Rechte speichern</button
												>
											</div>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<section class="card space-y-4 p-5">
				<SectionHead eyebrow="Zugang" title="Einladen" desc="Die Einladung geht per E-Mail an die Person." />
				<div class="grid gap-3 sm:grid-cols-3">
					<TextInput bind:value={inviteEmail} label="E-Mail" type="email" />
					<div class="flex flex-col gap-1.5">
						<label for="invite-role" class="label">Rolle</label>
						<select id="invite-role" class="input-base input-valid rounded-lg py-1.5" bind:value={inviteRole}>
							<option value="member">Mitglied</option>
							<option value="subcontractor">Subunternehmer</option>
						</select>
					</div>
					{#if inviteRole === 'subcontractor'}
						<TextInput bind:value={inviteRate} label="Kostensatz (€/h)" placeholder="z. B. 55,00" />
					{:else}
						<div class="flex flex-col gap-1.5">
							<label for="invite-preset" class="label">Rechte</label>
							<select id="invite-preset" class="input-base input-valid rounded-lg py-1.5" bind:value={invitePreset}>
								{#each Object.entries(team.PRESETS) as [key, p] (key)}
									<option value={key}>{p.label}</option>
								{/each}
							</select>
						</div>
					{/if}
				</div>
				<button class="btn-primary" disabled={busy || !inviteEmail.trim()} onclick={sendInvite}
					>Einladung senden</button
				>
				{#if invitations.length > 0}
					<div class="table-scroll overflow-hidden rounded-lg ring-1 ring-zinc-900/5 dark:ring-white/10">
						<table class="w-full text-sm">
							<thead class="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
								<tr>
									<th class="px-3 py-2 text-left">E-Mail</th>
									<th class="px-3 py-2 text-left">Rolle</th>
									<th class="px-3 py-2 text-left">Status</th>
									<th class="px-3 py-2 text-left">Gültig bis</th>
									<th class="px-3 py-2"></th>
								</tr>
							</thead>
							<tbody>
								{#each invitations as i (i.id)}
									<tr class="border-b border-zinc-100 text-zinc-700 transition duration-200 ease-spring hover:bg-zinc-50/70 dark:border-zinc-700/70 dark:text-zinc-200 dark:hover:bg-white/[0.02]">
										<td class="px-3 py-2">{i.email}</td>
										<td class="px-3 py-2">
											{ROLES[i.role]}{#if i.grants.length}
												<span class="text-zinc-500">
													· {i.grants.map((g) => `${AREA_LABELS[g.area]}${g.level === 'view' ? ' (lesen)' : ''}`).join(', ')}</span
												>
											{/if}{#if i.cost_rate_cents != null}
												<span class="text-zinc-500"> · {formatCents(i.cost_rate_cents)}/h</span>
											{/if}
										</td>
										<td class="px-3 py-2">
											<span class={`badge ${INVITE_STATUS[i.status][1]}`}
												>{INVITE_STATUS[i.status][0]}</span
											>
										</td>
										<td class="px-3 py-2 tabular-nums">
											{i.status === 'accepted' && i.accepted_at
												? `angenommen ${day(i.accepted_at)}`
												: day(i.expires_at)}
										</td>
										<td class="px-3 py-2 text-right">
											{#if i.status !== 'accepted'}
												<button class="icon-btn icon-btn-danger" disabled={busy} onclick={() => revoke(i)} title={i.status === 'pending' ? 'Widerrufen' : 'Entfernen'} aria-label={i.status === 'pending' ? 'Widerrufen' : 'Entfernen'}>
													<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
												</button>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>

		{/if}

		<section class="card space-y-4 p-5">
			<SectionHead eyebrow="Beitreten" title="Einladung annehmen" desc="Füge den Einladungslink aus der E-Mail (oder nur den Code) ein." />
			<TextInput bind:value={token} label="Einladungslink oder Code" />
			<button class="btn-primary" disabled={busy || !token.trim()} onclick={accept}>Annehmen</button>
		</section>
	</div>
{/if}

<Dialog open={ask !== null} title={ask?.title} size="sm" onclose={closeAsk}>
	<p class="text-sm text-zinc-600 dark:text-zinc-300">{ask?.body}</p>
	{#snippet footer()}
		<button type="button" class="btn-secondary" onclick={closeAsk}>Abbrechen</button>
		<button
			type="button"
			class={ask?.danger ? 'btn-danger' : 'btn-primary'}
			onclick={() => {
				const ok = ask?.ok;
				ask = null;
				ok?.();
			}}>{ask?.label}</button
		>
	{/snippet}
</Dialog>
