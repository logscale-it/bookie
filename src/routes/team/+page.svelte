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
		});
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
		const reason = prompt(`Was soll ${name} für ${team.monthLabel(m)} korrigieren?`)?.trim();
		if (!reason) return;
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
				<p class="text-sm text-zinc-600 dark:text-zinc-300">
					Stunden, Freigaben und Aktivität von {session.company?.name ?? 'deiner Firma'}.
					{#if session.company?.role === 'admin'}
						Mitglieder und Rechte: <a class="underline" href="/einstellungen/team">Einstellungen → Team</a>.
					{/if}
				</p>
			</div>
			<div class="flex flex-col gap-1">
				<label for="team-month" class="label">Monat</label>
				<input id="team-month" type="month" class="input-base input-valid" value={month} onchange={(e) => pickMonth(e.currentTarget.value)} />
			</div>
		</header>

		{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
		{#if notice}<p class="text-sm text-green-700 dark:text-green-400">{notice}</p>{/if}

		<section class="card space-y-3" data-testid="team-hours">
			<h2 class="text-base font-semibold">Stunden je Person · {team.monthLabel(month)}</h2>
			<div class="table-scroll">
				<table class="w-full text-sm">
					<thead class="table-head">
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
							<tr class="data-row align-top">
								<td class="px-3 py-2">
									<button type="button" class="text-left font-medium" onclick={() => (open = open === p.user_id ? null : p.user_id)} disabled={!p.projects.length}>
										{p.user_name}
										{#if p.projects.length}<span class="text-xs text-zinc-400">{open === p.user_id ? '▾' : '▸'}</span>{/if}
									</button>
									<span class="badge {p.role ? 'badge-zinc' : 'badge-amber'} ml-1">{p.role ? ROLES[p.role] : 'ehemalig'}</span>
									{#if open === p.user_id}
										{#each p.projects as r (r.project_id)}
											<div class="mt-1 text-xs text-zinc-500">
												{r.project_name ?? 'ohne Projekt'}: {hours(r.minutes)} h{r.cost_cents !== undefined ? ` · ${formatCents(r.cost_cents)}` : ''}
											</div>
										{/each}
									{/if}
								</td>
								<td class="px-3 py-2 text-right">{hours(p.minutes)}</td>
								<td class="px-3 py-2 text-right">
									{hours(p.approved_minutes)}
									{#if p.minutes > p.approved_minutes}
										<div class="text-xs text-amber-700 dark:text-amber-400">{hours(p.minutes - p.approved_minutes)} offen</div>
									{/if}
								</td>
								<td class="px-3 py-2 text-right">{hours(p.invoiced_minutes)}</td>
								{#if money}
									<td class="px-3 py-2 text-right">{formatCents(p.cost_cents)}</td>
									<td class="px-3 py-2 text-right">{formatCents(p.revenue_cents)}</td>
								{/if}
								{#if canApprove}
									<td class="px-3 py-2 text-right whitespace-nowrap">
										{#if p.minutes > p.approved_minutes}
											<button class="btn-primary" disabled={busy} onclick={() => approve(true, p.user_id)}>Freigeben</button>
											<button class="btn-secondary" disabled={busy} onclick={() => reject(p.user_id, p.user_name)}>Zurückgeben</button>
										{:else if p.approved_minutes > p.invoiced_minutes}
											<button class="btn-secondary" disabled={busy} onclick={() => approve(false, p.user_id)}>Freigabe zurücknehmen</button>
										{/if}
									</td>
								{/if}
							</tr>
						{:else}
							<tr><td class="empty-state px-3 py-4" colspan="7">Keine Zeiten in diesem Monat.</td></tr>
						{/each}
					</tbody>
					{#if people.length > 1}
						<tfoot>
							<tr class="font-semibold">
								<td class="px-3 py-2">Summe</td>
								<td class="px-3 py-2 text-right">{hours(totals.minutes)}</td>
								<td class="px-3 py-2 text-right">{hours(totals.approved)}</td>
								<td class="px-3 py-2 text-right">{hours(totals.invoiced)}</td>
								{#if money}
									<td class="px-3 py-2 text-right">{formatCents(totals.cost)}</td>
									<td class="px-3 py-2 text-right">{formatCents(totals.revenue)}</td>
								{/if}
								{#if canApprove}<td></td>{/if}
							</tr>
						</tfoot>
					{/if}
				</table>
			</div>
			<p class="text-xs text-zinc-500 dark:text-zinc-400">
				Freigegebene Einträge sind gesperrt, der Kostensatz wird festgeschrieben. „Zurückgeben“ schickt den Monat mit
				einem Grund per E-Mail an die Person.{money ? ' Kosten = Stunden × Kostensatz, Umsatz = abrechenbare Stunden × Projekt-Stundensatz.' : ''}
			</p>
		</section>

		{#if canApprove}
			<section class="card space-y-3">
				<h2 class="text-base font-semibold">Offene Freigaben</h2>
				{#if pending.length}
					<ul class="divide-y divide-zinc-200 dark:divide-zinc-700" data-testid="pending-approvals">
						{#each pending as p (`${p.user_id}|${p.month}`)}
							<li class="flex items-center justify-between gap-3 py-2 text-sm">
								<span>
									<strong>{p.user_name}</strong> · {team.monthLabel(p.month)}
									<span class="text-zinc-500">· {hours(p.minutes)} h in {p.entries} Einträgen</span>
								</span>
								<span class="whitespace-nowrap">
									<button class="btn-primary" disabled={busy} onclick={() => approve(true, p.user_id, p.month)}>Freigeben</button>
									<button class="btn-secondary" disabled={busy} onclick={() => reject(p.user_id, p.user_name, p.month)}>Zurückgeben</button>
								</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-green-700 dark:text-green-400">Keine offenen Stunden.</p>
				{/if}
			</section>
		{/if}

		{#if canFeed}
			<section class="card space-y-3" data-testid="team-activity">
				<h2 class="text-base font-semibold">Aktivität</h2>
				{#if feed.length}
					<ul class="divide-y divide-zinc-200 text-sm dark:divide-zinc-700">
						{#each feed as a (a.id)}
							<li class="flex justify-between gap-3 py-2">
								<span>{team.describe(a, (id) => projectNames.get(id) ?? `#${id}`)}</span>
								<span class="whitespace-nowrap text-xs text-zinc-500">{when(a.created_at)}</span>
							</li>
						{/each}
					</ul>
					{#if !feedDone}
						<button class="btn-secondary" disabled={busy} onclick={() => run(() => loadFeed(true))}>Mehr</button>
					{/if}
				{:else}
					<p class="empty-state">Noch keine Aktivität.</p>
				{/if}
			</section>
		{/if}
	</section>
{/if}
