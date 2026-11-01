<script lang="ts">
	// Cloud mode: the team at a glance for the admin and team leads (team_time or
	// reports grant): hours per person and month, approvals and the activity feed.
	// Members, rights and invites stay under Einstellungen → Team (admin only).
	import { can, session } from '$lib/session.svelte';
	import { onMount } from 'svelte';
	import { cloud, CloudError } from '$lib/cloud';
	import { listProjects } from '$lib/db/projects';
	import { formatCents } from '$lib/shared/money';
	import { messageForUnknown } from '$lib/shared/errors';
	import * as team from '$lib/team';
	import Dialog from '../../common/Dialog.svelte';
	import SkeletonRows from '../../common/SkeletonRows.svelte';
	import EmptyState from '../../common/EmptyState.svelte';

	const ROLES: Record<team.Role, string> = { admin: 'Admin', member: 'Mitglied', subcontractor: 'Subunternehmer' };
	const MESSAGES: Record<string, string> = {
		invalid_input: 'Bitte einen Grund angeben.',
		nothing_to_reject: 'In diesem Monat ist nichts mehr offen.'
	};
	const message = (e: unknown) => (e instanceof CloudError && MESSAGES[e.code]) || messageForUnknown(e);
	const hours = (min: number) => (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 });
	const when = (iso: string) =>
		new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

	const isCloud = cloud();
	let month = $state(new Date().toISOString().slice(0, 7));
	let report = $state<team.TeamRow[]>([]);
	let pending = $state<team.PendingRow[]>([]);
	let feed = $state<team.Activity[]>([]);
	let feedDone = $state(false);
	let projectNames = $state(new Map<number, string>());
	let open = $state<number | null>(null);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let loaded = $state(false);
	let rejectTarget = $state<{ userId: number; name: string; m: string } | null>(null);
	let rejectReason = $state('');

	const canApprove = $derived(can('team_time', 'edit'));
	const canFeed = $derived(can('team_time'));
	const money = $derived(report.some((r) => r.cost_cents !== undefined));
	// Everyone in the company (also without hours this month), then former members with hours.
	const people = $derived.by(() => {
		const sums = team.summarize(report);
		const current = (session.me?.active?.members ?? []).map(
			(m) =>
				sums.find((s) => s.user_id === m.id) ?? {
					user_id: m.id,
					user_name: m.name,
					role: m.role,
					minutes: 0,
					approved_minutes: 0,
					invoiced_minutes: 0,
					cost_cents: 0,
					revenue_cents: 0,
					projects: []
				}
		);
		return [...current, ...sums.filter((s) => !current.some((c) => c.user_id === s.user_id))];
	});
	const totals = $derived(
		people.reduce(
			(t, p) => ({
				minutes: t.minutes + p.minutes,
				approved: t.approved + p.approved_minutes,
				invoiced: t.invoiced + p.invoiced_minutes,
				cost: t.cost + p.cost_cents,
				revenue: t.revenue + p.revenue_cents
			}),
			{ minutes: 0, approved: 0, invoiced: 0, cost: 0, revenue: 0 }
		)
	);

	onMount(() => {
		if (!isCloud) return;
		run(async () => {
			const companyId = session.company?.id;
			if (companyId) projectNames = new Map((await listProjects(companyId)).map((p) => [p.id, p.name]));
			await Promise.all([loadReport(), loadPending(), loadFeed()]);
		}).finally(() => (loaded = true));
	});

	const loadReport = async () => {
		if (/^\d{4}-\d{2}$/.test(month)) report = await team.teamReport(month);
	};
	const loadPending = async () => {
		if (canApprove) pending = await team.pendingApprovals();
	};
	async function loadFeed(more = false) {
		if (!canFeed) return;
		const page = await team.activity(more ? feed.at(-1)?.id : undefined);
		feed = more ? [...feed, ...page] : page;
		feedDone = page.length < 50;
	}

	async function run(fn: () => Promise<unknown>) {
		busy = true;
		error = notice = '';
		try {
			await fn();
		} catch (e) {
			error = message(e);
		} finally {
			busy = false;
		}
	}

	const refresh = () => Promise.all([loadReport(), loadPending(), loadFeed()]);

	const approve = (on: boolean, userId: number, m = month) =>
		run(async () => {
			const n = on ? (await team.approveMonth(userId, m)).approved : (await team.unapproveMonth(userId, m)).unapproved;
			await refresh();
			notice = `${n} Einträge ${on ? 'freigegeben' : 'zurückgenommen'}.`;
		});

	const reject = (userId: number, name: string, m = month) => {
		rejectReason = '';
		rejectTarget = { userId, name, m };
	};

	const confirmReject = () => {
		const reason = rejectReason.trim();
		if (!rejectTarget || !reason) return;
		const { userId, name, m } = rejectTarget;
		rejectTarget = null;
		run(async () => {
			await team.rejectMonth(userId, m, reason);
			await refresh();
			notice = `${team.monthLabel(m)} an ${name} zurückgegeben.`;
		});
	};

	const pickMonth = (v: string) => {
		month = v;
		run(loadReport);
	};
</script>

{#if !isCloud}
	<section class="card">
		<p class="text-sm">Die Teamübersicht ist nur mit bookie Cloud verfügbar.</p>
	</section>
{:else}
	<section class="space-y-6">
		<header class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h1 class="page-header">Team</h1>
				<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
					Stunden, Freigaben und Aktivität von {session.company?.name ?? 'deiner Firma'}.
					{#if session.company?.role === 'admin'}
						Mitglieder und Rechte: <a class="font-medium text-accent-600 hover:underline dark:text-accent-400" href="/einstellungen/team">Einstellungen → Team</a>.
					{/if}
				</p>
			</div>
			<div class="flex flex-col gap-1.5">
				<label for="team-month" class="label">Monat</label>
				<input id="team-month" type="month" class="input-base input-valid rounded-lg" value={month} onchange={(e) => pickMonth(e.currentTarget.value)} />
			</div>
		</header>

		{#if error}<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-600/10 dark:bg-red-950/40 dark:text-red-300">{error}</p>{/if}
		{#if notice}<p class="animate-pop rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-600/10 dark:bg-emerald-950/40 dark:text-emerald-300">{notice}</p>{/if}

		<section class="space-y-3" data-testid="team-hours">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">Stunden je Person · {team.monthLabel(month)}</h2>
			<div class="table-card table-scroll">
				{#if !loaded}
					<SkeletonRows rows={4} cols={5} />
				{:else}
				<table class="w-full text-sm">
					<thead class="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
						<tr>
							<th class="px-3 py-2 text-left">Person</th>
							<th class="px-3 py-2 text-right">Stunden</th>
							<th class="px-3 py-2 text-right">freigegeben</th>
							<th class="px-3 py-2 text-right">abgerechnet</th>
							{#if money}
								<th class="px-3 py-2 text-right">Kosten</th>
								<th class="px-3 py-2 text-right">Umsatz</th>
							{/if}
							{#if canApprove}<th class="px-3 py-2"></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each people as p (p.user_id)}
							<tr class="border-b border-zinc-100 align-top text-zinc-700 transition duration-200 ease-spring last:border-0 hover:bg-zinc-50/70 dark:border-zinc-700/70 dark:text-zinc-200 dark:hover:bg-white/[0.02]">
								<td class="px-3 py-2">
									<button type="button" class="inline-flex items-center gap-1 text-left font-medium text-zinc-900 dark:text-zinc-100" onclick={() => (open = open === p.user_id ? null : p.user_id)} disabled={!p.projects.length} aria-expanded={open === p.user_id}>
										{#if p.projects.length}<svg class="h-3.5 w-3.5 text-zinc-400 transition-transform duration-200 ease-spring {open === p.user_id ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>{/if}
										{p.user_name}
									</button>
									<span class="badge {p.role ? 'badge-zinc' : 'badge-amber'} ml-1">{p.role ? ROLES[p.role] : 'ehemalig'}</span>
									{#if open === p.user_id}
										{#each p.projects as r (r.project_id)}
											<div class="mt-1 pl-5 text-xs tabular-nums text-zinc-500">
												{r.project_name ?? 'ohne Projekt'}: {hours(r.minutes)} h{r.cost_cents !== undefined ? ` · ${formatCents(r.cost_cents)}` : ''}
											</div>
										{/each}
									{/if}
								</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(p.minutes)}</td>
								<td class="px-3 py-2 text-right tabular-nums">
									{hours(p.approved_minutes)}
									{#if p.minutes > p.approved_minutes}
										<div class="text-xs text-amber-700 dark:text-amber-400">{hours(p.minutes - p.approved_minutes)} offen</div>
									{/if}
								</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(p.invoiced_minutes)}</td>
								{#if money}
									<td class="px-3 py-2 text-right tabular-nums">{formatCents(p.cost_cents)}</td>
									<td class="px-3 py-2 text-right tabular-nums">{formatCents(p.revenue_cents)}</td>
								{/if}
								{#if canApprove}
									<td class="whitespace-nowrap px-3 py-2 text-right">
										{#if p.minutes > p.approved_minutes}
											<button class="btn-primary px-3 py-1.5 text-xs" disabled={busy} onclick={() => approve(true, p.user_id)}>Freigeben</button>
											<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => reject(p.user_id, p.user_name)}>Zurückgeben</button>
										{:else if p.approved_minutes > p.invoiced_minutes}
											<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => approve(false, p.user_id)}>Freigabe zurücknehmen</button>
										{/if}
									</td>
								{/if}
							</tr>
						{:else}
							<tr><td colspan="7"><EmptyState icon="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" title="Keine Zeiten in diesem Monat." /></td></tr>
						{/each}
					</tbody>
					{#if people.length > 1}
						<tfoot>
							<tr class="border-t border-zinc-200 bg-zinc-50/60 font-semibold dark:border-zinc-700 dark:bg-zinc-800/60">
								<td class="px-3 py-2">Summe</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(totals.minutes)}</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(totals.approved)}</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(totals.invoiced)}</td>
								{#if money}
									<td class="px-3 py-2 text-right tabular-nums">{formatCents(totals.cost)}</td>
									<td class="px-3 py-2 text-right tabular-nums">{formatCents(totals.revenue)}</td>
								{/if}
								{#if canApprove}<td></td>{/if}
							</tr>
						</tfoot>
					{/if}
				</table>
				{/if}
			</div>
			<p class="text-xs text-zinc-500 dark:text-zinc-400">
				Freigegebene Einträge sind gesperrt, der Kostensatz wird festgeschrieben. „Zurückgeben“ schickt den Monat mit
				einem Grund per E-Mail an die Person.{money ? ' Kosten = Stunden × Kostensatz, Umsatz = abrechenbare Stunden × Projekt-Stundensatz.' : ''}
			</p>
		</section>

		{#if canApprove}
			<section class="card space-y-3">
				<h2 class="text-base font-semibold tracking-tight">Offene Freigaben</h2>
				{#if pending.length}
					<ul class="divide-y divide-zinc-100 dark:divide-zinc-700/70" data-testid="pending-approvals">
						{#each pending as p (`${p.user_id}|${p.month}`)}
							<li class="flex items-center justify-between gap-3 py-2 text-sm">
								<span>
									<strong>{p.user_name}</strong> · {team.monthLabel(p.month)}
									<span class="tabular-nums text-zinc-500">· {hours(p.minutes)} h in {p.entries} Einträgen</span>
								</span>
								<span class="flex gap-1.5 whitespace-nowrap">
									<button class="btn-primary px-3 py-1.5 text-xs" disabled={busy} onclick={() => approve(true, p.user_id, p.month)}>Freigeben</button>
									<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => reject(p.user_id, p.user_name, p.month)}>Zurückgeben</button>
								</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
						Keine offenen Stunden.
					</p>
				{/if}
			</section>
		{/if}

		{#if canFeed}
			<section class="card space-y-3" data-testid="team-activity">
				<h2 class="text-base font-semibold tracking-tight">Aktivität</h2>
				{#if feed.length}
					<ul class="divide-y divide-zinc-100 text-sm dark:divide-zinc-700/70">
						{#each feed as a (a.id)}
							<li class="flex justify-between gap-3 py-2">
								<span>{team.describe(a, (id) => projectNames.get(id) ?? `#${id}`)}</span>
								<span class="whitespace-nowrap text-xs tabular-nums text-zinc-500">{when(a.created_at)}</span>
							</li>
						{/each}
					</ul>
					{#if !feedDone}
						<button class="btn-secondary" disabled={busy} onclick={() => run(() => loadFeed(true))}>Mehr</button>
					{/if}
				{:else if !loaded}
					<div class="space-y-2.5">
						<div class="skeleton h-3 w-3/4"></div>
						<div class="skeleton h-3 w-1/2"></div>
						<div class="skeleton h-3 w-2/3"></div>
					</div>
				{:else}
					<EmptyState icon="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" title="Noch keine Aktivität." />
				{/if}
			</section>
		{/if}
	</section>
{/if}

<Dialog open={rejectTarget !== null} title="Monat zurückgeben" size="sm" onclose={() => (rejectTarget = null)}>
	{#if rejectTarget}
		<form
			id="reject-form"
			class="space-y-1.5"
			onsubmit={(e) => {
				e.preventDefault();
				confirmReject();
			}}
		>
			<label for="reject-reason" class="label">Was soll {rejectTarget.name} für {team.monthLabel(rejectTarget.m)} korrigieren?</label>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea id="reject-reason" rows="3" autofocus class="input-base input-valid rounded-lg" bind:value={rejectReason}></textarea>
			<p class="text-xs text-zinc-500 dark:text-zinc-400">Der Grund geht per E-Mail an die Person.</p>
		</form>
	{/if}
	{#snippet footer()}
		<button type="button" class="btn-secondary" onclick={() => (rejectTarget = null)}>Abbrechen</button>
		<button type="submit" form="reject-form" class="btn-primary" disabled={!rejectReason.trim()}>Zurückgeben</button>
	{/snippet}
</Dialog>
