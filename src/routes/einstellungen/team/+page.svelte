<script lang="ts">
	import { can, refreshMe } from '$lib/session.svelte';
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import CloudWorkContext from '../../../common/CloudWorkContext.svelte';
	import { cloud, CloudError, type Me } from '$lib/cloud';
	import { listProjects } from '$lib/db/projects';
	import type { Project } from '$lib/db/types';
	import { formatCents } from '$lib/shared/money';
	import { messageForUnknown } from '$lib/shared/errors';
	import * as team from '$lib/team';

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
	const hours = (min: number) => (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 });
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
	let projects = $state<Project[]>([]);
	let editing = $state<number | null>(null);
	let inviteEmail = $state('');
	let inviteRole = $state<'member' | 'subcontractor'>('member');
	let inviteRate = $state('');
	let invitePreset = $state('member');
	let pendingMonths = $state<team.PendingRow[]>([]);
	let token = $state('');
	let approveUser = $state<number | null>(null);
	let month = $state(new Date().toISOString().slice(0, 7));
	let report = $state<team.SubcontractorRow[] | null>(null);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');

	const active = $derived(me?.companies.find((c) => c.id === me?.activeCompanyId));
	const admin = $derived(active?.role === 'admin');
	// Admins and members with team_time edit (e.g. the "Teamleitung" preset).
	const canApprove = $derived(!!active && can('team_time', 'edit'));
	const pending = $derived(invitations.filter((i) => i.status === 'pending').length);
	const subs = $derived(members.filter((m) => m.role === 'subcontractor'));
	const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? `#${id}`;
	// Current subcontractors (also without hours) plus former ones that still have hours this month.
	const overview = $derived.by(() => {
		const sums = team.summarize(report ?? []);
		const zero = (m: team.TeamMember): team.SubcontractorSummary => ({
			user_id: m.user_id,
			user_name: m.name,
			minutes: 0,
			approved_minutes: 0,
			cost_cents: 0,
			revenue_cents: 0,
			projects: []
		});
		return [
			...subs.map((m) => ({ member: m, sum: sums.find((s) => s.user_id === m.user_id) ?? zero(m) })),
			...sums
				.filter((s) => !members.some((m) => m.user_id === s.user_id))
				.map((s) => ({ member: null, sum: s }))
		];
	});
	const totals = $derived(
		overview.reduce(
			(t, { sum }) => ({
				minutes: t.minutes + sum.minutes,
				approved: t.approved + sum.approved_minutes,
				cost: t.cost + sum.cost_cents,
				revenue: t.revenue + sum.revenue_cents
			}),
			{ minutes: 0, approved: 0, cost: 0, revenue: 0 }
		)
	);

	onMount(() => session && run(load));

	async function load() {
		me = await refreshMe();
		if (active?.role === 'member') report = await team.subcontractorReport(month).catch(() => null);
		if (canApprove) pendingMonths = await team.pendingApprovals();
		if (active?.role !== 'admin') return;
		members = await team.listMembers();
		invitations = await team.listInvitations();
		report = await team.subcontractorReport(month);
		rates = Object.fromEntries(members.map((m) => [m.user_id, eur(m.cost_rate_cents)]));
		grants = Object.fromEntries(
			members.map((m) => [
				m.user_id,
				Object.fromEntries(
					team.AREAS.map((a) => [a, m.grants.find((g) => g.area === a)?.level ?? ''])
				) as Record<team.Area, GrantLevel>
			])
		);
		projects = await listProjects(active.id);
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
		if (!confirm(`Einladung an ${i.email} widerrufen?`)) return;
		run(async () => {
			await team.revokeInvitation(i.id);
			invitations = await team.listInvitations();
		}, 'Einladung widerrufen.');
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
		if (
			role === 'subcontractor' &&
			m.grants.length > 0 &&
			!confirm(`${m.name} wird Subunternehmer und verliert alle Bereichsrechte. Fortfahren?`)
		) {
			select.value = m.role;
			return;
		}
		run(async () => {
			await team.setRole(m.user_id, role);
			await load();
		}, 'Rolle geändert.');
	};

	// Admin moves to the other member; this page then shows the member view.
	const handOver = (m: team.TeamMember) => {
		if (!confirm(`${m.name} wird Admin von ${active?.name} (Abo, Team, alle Bereiche). Du bleibst Mitglied mit Bearbeitungsrechten in allen Bereichen. Fortfahren?`)) return;
		run(async () => {
			await team.makeAdmin(m.user_id);
			location.reload();
		});
	};

	const remove = (m: team.TeamMember) => {
		if (!confirm(`${m.name} aus der Firma entfernen?`)) return;
		run(async () => {
			await team.removeMember(m.user_id);
			await load();
		}, 'Mitglied entfernt.');
	};

	const toggleAssignment = (userId: number, projectId: number, on: boolean) =>
		run(async () => {
			await (on ? team.assign(projectId, userId) : team.unassign(projectId, userId));
			members = await team.listMembers();
		});

	const approve = (on: boolean, userId = approveUser, m = month) =>
		run(async () => {
			if (userId == null) return;
			const n = on
				? (await team.approveMonth(userId, m)).approved
				: (await team.unapproveMonth(userId, m)).unapproved;
			report = await team.subcontractorReport(month).catch(() => null); // needs reports view
			pendingMonths = await team.pendingApprovals();
			notice = `${n} Einträge ${on ? 'freigegeben' : 'zurückgenommen'}.`;
		}, '');

	const loadReport = () => run(async () => (report = await team.subcontractorReport(month)));
	const pickMonth = (v: string) => {
		month = v;
		if ((admin || report) && /^\d{4}-\d{2}$/.test(v)) loadReport();
	};
</script>

{#if !session}
	<section class="card">
		<p class="text-sm">Die Teamverwaltung ist nur mit bookie Cloud verfügbar.</p>
	</section>
{:else}
	<div class="space-y-6">
		{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
		{#if notice}<p class="text-sm text-green-700 dark:text-green-400">{notice}</p>{/if}

		{#if active && !admin}
			<CloudWorkContext />
		{/if}

		{#if admin}
			<section class="card space-y-2" data-testid="team-seats">
				<h2 class="text-base font-semibold">Lizenzen</h2>
				<p class="text-sm">
					<strong>{members.length} {members.length === 1 ? 'Platz' : 'Plätze'}</strong> im Abo von
					{active?.name}: {members.filter((m) => m.role === 'admin').length} Admin,
					{members.filter((m) => m.role === 'member').length} Mitglieder, {subs.length} Subunternehmer.
				</p>
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					Jedes Mitglied, auch jeder Subunternehmer, ist ein bezahlter Platz in deinem Abo. Nimmt
					jemand eine Einladung an oder wird entfernt, passt bookie die Anzahl automatisch an und
					rechnet anteilig ab. Offene Einladungen ({pending}) kosten nichts. Abo und Rechnungen:
					<a class="underline" href="/einstellungen/cloud">Einstellungen → Konto & Abo</a>.
				</p>
			</section>
		{/if}

		{#if active && active.role !== 'subcontractor'}
			<section class="card space-y-4" data-testid="team-subcontractors">
				<div class="flex flex-wrap items-end justify-between gap-3">
					<h2 class="text-base font-semibold">Subunternehmer</h2>
					<div class="flex flex-col gap-1">
						<label for="sub-month" class="label">Monat</label>
						<input
							id="sub-month"
							type="month"
							class="input-base input-valid"
							value={month}
							onchange={(e) => pickMonth(e.currentTarget.value)}
						/>
					</div>
				</div>
				{#if overview.length === 0}
					<p class="empty-state">
						{admin
							? 'Noch keine Subunternehmer. Lade unten jemanden mit der Rolle „Subunternehmer“ ein.'
							: report == null
								? 'Für diese Übersicht brauchst du das Recht „Berichte“.'
								: 'Keine Subunternehmer-Zeiten in diesem Monat.'}
					</p>
				{:else}
					<div class="table-scroll">
						<table class="w-full text-sm">
							<thead class="table-head">
								<tr>
									<th class="px-3 py-2 text-left">Subunternehmer</th>
									<th class="px-3 py-2 text-left">Projekte</th>
									<th class="px-3 py-2 text-right">Satz</th>
									<th class="px-3 py-2 text-right">Stunden</th>
									<th class="px-3 py-2 text-right">freigegeben</th>
									<th class="px-3 py-2 text-right">Kosten</th>
									<th class="px-3 py-2 text-right">Umsatz</th>
									{#if admin}<th class="px-3 py-2"></th>{/if}
								</tr>
							</thead>
							<tbody>
								{#each overview as { member: m, sum } (sum.user_id)}
									<tr class="data-row align-top">
										<td class="px-3 py-2">
											<div class="font-medium">{sum.user_name}</div>
											{#if m}
												<div class="text-xs text-zinc-500">{m.email}</div>
											{:else if admin}
												<span class="badge badge-zinc">ehemalig</span>
											{/if}
										</td>
										<td class="px-3 py-2">
											{#if m && admin && editing === m.user_id}
												<ul class="space-y-1">
													{#each projects as p (p.id)}
														<li>
															<label class="flex items-center gap-2">
																<input
																	type="checkbox"
																	checked={m.project_ids.includes(p.id)}
																	disabled={busy}
																	onchange={(e) =>
																		toggleAssignment(m.user_id, p.id, e.currentTarget.checked)}
																/>
																{p.name}
															</label>
														</li>
													{:else}
														<li class="text-xs text-zinc-500">Noch keine Projekte angelegt.</li>
													{/each}
												</ul>
												<button class="btn-secondary mt-2" onclick={() => (editing = null)}>Fertig</button>
											{:else if m}
												{#if m.project_ids.length === 0}
													<span class="text-xs text-amber-700 dark:text-amber-400"
														>keinem Projekt zugewiesen</span
													>
												{:else}
													{m.project_ids.map(projectName).join(', ')}
												{/if}
												{#if admin}
													<button
														class="ml-1 text-xs text-blue-600 underline dark:text-blue-400"
														onclick={() => (editing = m.user_id)}>bearbeiten</button
													>
												{/if}
											{/if}
											{#each sum.projects as p (p.project_id)}
												<div class="text-xs text-zinc-500">
													{p.project_name ?? 'ohne Projekt'}: {hours(p.minutes)} h · {formatCents(
														p.cost_cents
													)}
												</div>
											{/each}
										</td>
										<td class="px-3 py-2 text-right whitespace-nowrap"
											>{m?.cost_rate_cents == null ? '–' : `${formatCents(m.cost_rate_cents)}/h`}</td
										>
										<td class="px-3 py-2 text-right">{hours(sum.minutes)}</td>
										<td class="px-3 py-2 text-right">
											{hours(sum.approved_minutes)}
											{#if sum.minutes > sum.approved_minutes}
												<div class="text-xs text-amber-700 dark:text-amber-400">
													{hours(sum.minutes - sum.approved_minutes)} offen
												</div>
											{/if}
										</td>
										<td class="px-3 py-2 text-right">{formatCents(sum.cost_cents)}</td>
										<td class="px-3 py-2 text-right">{formatCents(sum.revenue_cents)}</td>
										{#if admin}
											<td class="px-3 py-2 text-right whitespace-nowrap">
												{#if sum.minutes > sum.approved_minutes}
													<button
														class="btn-primary"
														disabled={busy}
														onclick={() => approve(true, sum.user_id)}>Freigeben</button
													>
												{:else if sum.approved_minutes > 0}
													<button
														class="btn-secondary"
														disabled={busy}
														onclick={() => approve(false, sum.user_id)}>Zurücknehmen</button
													>
												{/if}
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
							<tfoot>
								<tr class="font-semibold">
									<td class="px-3 py-2" colspan="3">Summe</td>
									<td class="px-3 py-2 text-right">{hours(totals.minutes)}</td>
									<td class="px-3 py-2 text-right">{hours(totals.approved)}</td>
									<td class="px-3 py-2 text-right">{formatCents(totals.cost)}</td>
									<td class="px-3 py-2 text-right">{formatCents(totals.revenue)}</td>
									{#if admin}<td></td>{/if}
								</tr>
							</tfoot>
						</table>
					</div>
					<p class="text-xs text-zinc-500 dark:text-zinc-400">
						Subunternehmer sehen nur die Projekte, denen sie zugewiesen sind. Kosten = Stunden × Kostensatz (bei Freigabe festgeschrieben). Umsatz = abrechenbare Stunden ×
						Projekt-Stundensatz.
					</p>
				{/if}
			</section>
		{/if}

		{#if canApprove}
			<section class="card space-y-3">
				<h2 class="text-base font-semibold">Offene Freigaben</h2>
				{#if pendingMonths.length}
					<ul class="divide-y divide-zinc-200 dark:divide-zinc-700" data-testid="pending-approvals">
						{#each pendingMonths as p (`${p.user_id}|${p.month}`)}
							<li class="flex items-center justify-between gap-3 py-2 text-sm">
								<span>
									<strong>{p.user_name}</strong> ·
									{new Date(`${p.month}-01`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}
									<span class="text-zinc-500">· {hours(p.minutes)} h in {p.entries} Einträgen</span>
								</span>
								<button class="btn-primary" disabled={busy} onclick={() => approve(true, p.user_id, p.month)}
									>Freigeben</button
								>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-green-700 dark:text-green-400">Keine offenen Stunden.</p>
				{/if}
			</section>
		{/if}

		{#if admin}
			<section class="card space-y-4">
				<h2 class="text-base font-semibold">Mitglieder</h2>
				<div class="table-scroll">
					<table class="w-full text-sm">
						<thead class="table-head">
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
								<tr class="data-row">
									<td class="px-3 py-2">{m.name}</td>
									<td class="px-3 py-2">{m.email}</td>
									<td class="px-3 py-2">
										{#if m.role === 'admin'}
											<span class="badge badge-zinc">{ROLES[m.role]}</span>
										{:else}
											<select
												class="input-base input-valid"
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
													class="input-base input-valid w-28"
													inputmode="decimal"
													aria-label="Kostensatz"
													bind:value={rates[m.user_id]}
												/>
												<button
													class="btn-secondary"
													disabled={busy}
													onclick={() => saveRate(m.user_id)}>Speichern</button
												>
											</div>
										{/if}
									</td>
									<td class="px-3 py-2 text-right">
										{#if m.role === 'member'}
											<button class="btn-secondary" disabled={busy} onclick={() => handOver(m)}
												>Zum Admin machen</button
											>
										{/if}
										{#if m.role !== 'admin'}
											<button class="btn-danger" disabled={busy} onclick={() => remove(m)}
												>Entfernen</button
											>
										{/if}
									</td>
								</tr>
								{#if m.role === 'member' && grants[m.user_id]}
									<tr>
										<td colspan="5" class="px-3 pb-3">
											<div class="flex flex-wrap items-end gap-3">
												{#each team.AREAS as area (area)}
													<div class="flex flex-col gap-1">
														<label for={`grant-${m.user_id}-${area}`} class="label"
															>{AREA_LABELS[area]}</label
														>
														<select
															id={`grant-${m.user_id}-${area}`}
															class="input-base input-valid"
															bind:value={grants[m.user_id][area]}
														>
															<option value="">Kein Zugriff</option>
															<option value="view">Lesen</option>
															<option value="edit">Bearbeiten</option>
														</select>
													</div>
												{/each}
												<button
													class="btn-secondary"
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

			<section class="card space-y-4">
				<h2 class="text-base font-semibold">Einladen</h2>
				<div class="grid gap-3 sm:grid-cols-3">
					<TextInput bind:value={inviteEmail} label="E-Mail" type="email" />
					<div class="flex flex-col gap-1">
						<label for="invite-role" class="label">Rolle</label>
						<select id="invite-role" class="input-base input-valid" bind:value={inviteRole}>
							<option value="member">Mitglied</option>
							<option value="subcontractor">Subunternehmer</option>
						</select>
					</div>
					{#if inviteRole === 'subcontractor'}
						<TextInput bind:value={inviteRate} label="Kostensatz (€/h)" placeholder="z. B. 55,00" />
					{:else}
						<div class="flex flex-col gap-1">
							<label for="invite-preset" class="label">Rechte</label>
							<select id="invite-preset" class="input-base input-valid" bind:value={invitePreset}>
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
					<div class="table-scroll">
						<table class="w-full text-sm">
							<thead class="table-head">
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
									<tr class="data-row">
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
										<td class="px-3 py-2">
											{i.status === 'accepted' && i.accepted_at
												? `angenommen ${day(i.accepted_at)}`
												: day(i.expires_at)}
										</td>
										<td class="px-3 py-2 text-right">
											{#if i.status !== 'accepted'}
												<button class="btn-secondary" disabled={busy} onclick={() => revoke(i)}
													>{i.status === 'pending' ? 'Widerrufen' : 'Entfernen'}</button
												>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>

			<section class="card space-y-4">
				<h2 class="text-base font-semibold">Monatsfreigabe</h2>
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					Freigegebene Zeiteinträge sind gesperrt; der Kostensatz wird festgeschrieben.
				</p>

				<div class="grid gap-3 sm:grid-cols-2">
					<div class="flex flex-col gap-1">
						<label for="approve-user" class="label">Mitglied</label>
						<select id="approve-user" class="input-base input-valid" bind:value={approveUser}>
							<option value={null}>Mitglied wählen…</option>
							{#each members as m (m.user_id)}
								<option value={m.user_id}>{m.name}</option>
							{/each}
						</select>
					</div>
					<div class="flex flex-col gap-1">
						<label for="approve-month" class="label">Monat</label>
						<input
							id="approve-month"
							type="month"
							class="input-base input-valid"
							value={month}
							onchange={(e) => pickMonth(e.currentTarget.value)}
						/>
					</div>
				</div>
				<div class="flex gap-3">
					<button class="btn-primary" disabled={busy || approveUser == null} onclick={() => approve(true)}
						>Freigeben</button
					>
					<button
						class="btn-secondary"
						disabled={busy || approveUser == null}
						onclick={() => approve(false)}>Freigabe zurücknehmen</button
					>
				</div>
			</section>
		{/if}

		<section class="card space-y-4">
			<h2 class="text-base font-semibold">Einladung annehmen</h2>
			<p class="text-sm text-zinc-500 dark:text-zinc-400">
				Füge den Einladungslink aus der E-Mail (oder nur den Code) ein.
			</p>
			<TextInput bind:value={token} label="Einladungslink oder Code" />
			<button class="btn-primary" disabled={busy || !token.trim()} onclick={accept}>Annehmen</button>
		</section>
	</div>
{/if}
