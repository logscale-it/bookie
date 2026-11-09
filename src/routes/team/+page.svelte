<script lang="ts">
	// Cloud mode: the team at a glance for the admin and team leads (team_time or
	// reports grant): who is online, each person's month as a status bar
	// (abgerechnet / freigegeben / offen), approvals and the shared activity feed.
	// Members, rights and invites stay under Einstellungen → Team (admin only).
	import { can, session } from '$lib/session.svelte';
	import { onMount } from 'svelte';
	import { cloud, CloudError } from '$lib/cloud';
	import CloudTeaser from '../../common/CloudTeaser.svelte';
	import { listProjects } from '$lib/db/projects';
	import { formatCents } from '$lib/shared/money';
	import { messageForUnknown } from '$lib/shared/errors';
	import * as team from '$lib/team';
	import Dialog from '../../common/Dialog.svelte';
	import SkeletonRows from '../../common/SkeletonRows.svelte';
	import EmptyState from '../../common/EmptyState.svelte';
	import Avatar from '../../common/Avatar.svelte';
	import ActivityFeed from '../../common/ActivityFeed.svelte';
	import { presence } from '$lib/presence.svelte';
	import { getLocaleFormatting, t, tp } from '$lib/i18n';

	const ROLES: Record<team.Role, string> = { admin: 'shell.roleAdmin', member: 'shell.roleMember', subcontractor: 'shell.roleSubcontractor' };
	const MESSAGES: Record<string, string> = {
		invalid_input: 'teamPage.errInvalidInput',
		nothing_to_reject: 'teamPage.errNothingToReject',
		not_submitted: 'teamPage.errNotSubmitted'
	};
	const message = (e: unknown) => (e instanceof CloudError && MESSAGES[e.code] && t(MESSAGES[e.code])) || messageForUnknown(e);
	const hours = (min: number) => (min / 60).toLocaleString(getLocaleFormatting(), { maximumFractionDigits: 2 });

	const isCloud = cloud();
	let month = $state(new Date().toISOString().slice(0, 7));
	let report = $state<team.TeamRow[]>([]);
	let pending = $state<team.PendingRow[]>([]);
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
	const online = $derived(new Set(presence.peers.map((p) => p.userId)));
	// The selected month's open hours sit in the table; the card lists the other months.
	const otherPending = $derived(pending.filter((p) => p.month !== month));
	const submitted = (userId: number, m = month) => pending.some((p) => p.user_id === userId && p.month === m && p.submitted_at);
	// Others' months only once handed in (server: not_submitted); own hours directly.
	const approvable = (userId: number, m = month) => userId === session.me?.user.id || submitted(userId, m);

	type Sum = { minutes: number; approved_minutes: number; invoiced_minutes: number };
	const pct = (part: number, p: Sum) => `${p.minutes ? (part / p.minutes) * 100 : 0}%`;
	const status = (p: Sum) =>
		p.minutes === 0
			? { label: t('teamPage.statusNone'), cls: 'badge-zinc' }
			: p.minutes > p.approved_minutes
				? { label: t('teamPage.statusWaiting'), cls: 'badge-amber' }
				: p.approved_minutes > p.invoiced_minutes
					? { label: t('teamPage.statusApproved'), cls: 'badge-green' }
					: { label: t('teamPage.statusInvoiced'), cls: 'badge-blue' };
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
			await Promise.all([loadReport(), loadPending()]);
		}).finally(() => (loaded = true));
	});

	const loadReport = async () => {
		if (/^\d{4}-\d{2}$/.test(month)) report = await team.teamReport(month);
	};
	const loadPending = async () => {
		if (canApprove) pending = await team.pendingApprovals();
	};

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

	// Remount the feed after own actions so it shows them.
	let feedKey = $state(0);
	const refresh = () => Promise.all([loadReport(), loadPending()]).then(() => feedKey++);

	const approve = (on: boolean, userId: number, m = month) =>
		run(async () => {
			const n = on ? (await team.approveMonth(userId, m)).approved : (await team.unapproveMonth(userId, m)).unapproved;
			await refresh();
			notice = tp(on ? 'teamPage.approvedCount' : 'teamPage.unapprovedCount', { count: n });
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
			notice = tp('teamPage.rejectedNotice', { month: team.monthLabel(m), name });
		});
	};

	const pickMonth = (v: string) => {
		month = v;
		run(loadReport);
	};
</script>

{#if !isCloud}
	<CloudTeaser
		title={t('nav.team')}
		points={[t('teamPage.teaser1'), t('teamPage.teaser2'), t('teamPage.teaser3')]}
	/>
{:else}
	<section class="space-y-6">
		<header class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h1 class="page-header">{t('nav.team')}</h1>
				<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
					{tp('teamPage.intro', { name: session.company?.name ?? t('teamPage.yourCompany') })}
					{#if session.company?.role === 'admin'}
						{t('teamPage.adminLinkLead')} <a class="font-medium text-accent-600 hover:underline dark:text-accent-400" href="/einstellungen/team">{t('teamPage.adminLink')}</a>.
					{/if}
				</p>
			</div>
			<div class="flex flex-col gap-1.5">
				<label for="team-month" class="label">{t('teamPage.month')}</label>
				<input id="team-month" type="month" class="input-base input-valid rounded-lg" value={month} onchange={(e) => pickMonth(e.currentTarget.value)} />
			</div>
		</header>

		{#if error}<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-600/10 dark:bg-red-950/40 dark:text-red-300">{error}</p>{/if}
		{#if notice}<p class="animate-pop rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-600/10 dark:bg-emerald-950/40 dark:text-emerald-300">{notice}</p>{/if}

		<section class="space-y-3" data-testid="team-hours">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">{tp('teamPage.hoursTitle', { month: team.monthLabel(month) })}</h2>
			<div class="table-card table-scroll">
				{#if !loaded}
					<SkeletonRows rows={4} cols={5} />
				{:else}
				<table class="w-full text-sm">
					<thead class="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
						<tr>
							<th class="px-3 py-2 text-left">{t('teamPage.colPerson')}</th>
							<th class="w-1/3 min-w-48 px-3 py-2 text-left">{t('teamPage.colMonth')}</th>
							<th class="px-3 py-2 text-right">{t('teamPage.colHours')}</th>
							{#if money}
								<th class="px-3 py-2 text-right">{t('teamPage.colCost')}</th>
								<th class="px-3 py-2 text-right">{t('teamPage.colRevenue')}</th>
							{/if}
							{#if canApprove}<th class="px-3 py-2"></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each people as p (p.user_id)}
							{@const st = status(p)}
							<tr class="border-b border-zinc-100 align-top text-zinc-700 transition duration-200 ease-spring last:border-0 hover:bg-zinc-50/70 dark:border-zinc-700/70 dark:text-zinc-200 dark:hover:bg-white/[0.02]">
								<td class="px-3 py-2">
									<span class="relative mr-2 inline-flex align-middle">
										<Avatar id={p.user_id} name={p.user_name} dim={!p.role} />
										{#if online.has(p.user_id)}
											<span class="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-900" title={t('teamPage.online')}></span>
										{/if}
									</span>
									<button type="button" class="inline-flex items-center gap-1 text-left font-medium text-zinc-900 dark:text-zinc-100" onclick={() => (open = open === p.user_id ? null : p.user_id)} disabled={!p.projects.length} aria-expanded={open === p.user_id}>
										{#if p.projects.length}<svg class="h-3.5 w-3.5 text-zinc-400 transition-transform duration-200 ease-spring {open === p.user_id ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>{/if}
										{p.user_name}
									</button>
									<span class="badge {p.role ? 'badge-zinc' : 'badge-amber'} ml-1">{p.role ? t(ROLES[p.role]) : t('teamPage.former')}</span>
									{#if open === p.user_id}
										{#each p.projects as r (r.project_id)}
											<div class="mt-1 pl-5 text-xs tabular-nums text-zinc-500">
												{r.project_name ?? t('teamPage.noProject')}: {hours(r.minutes)} h{r.cost_cents !== undefined ? ` · ${formatCents(r.cost_cents)}` : ''}
											</div>
										{/each}
									{/if}
								</td>
								<td class="px-3 py-2.5">
									<div
										class="flex h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-700/60"
										role="img"
										aria-label={tp('teamPage.barLabel', { invoiced: hours(p.invoiced_minutes), approved: hours(p.approved_minutes - p.invoiced_minutes), open: hours(p.minutes - p.approved_minutes) })}
										title={tp('teamPage.barTitle', { invoiced: hours(p.invoiced_minutes), approved: hours(p.approved_minutes - p.invoiced_minutes), open: hours(p.minutes - p.approved_minutes) })}
									>
										<span class="bg-accent-500 transition-[width] duration-700 ease-spring" style:width={pct(p.invoiced_minutes, p)}></span>
										<span class="bg-emerald-500 transition-[width] duration-700 ease-spring" style:width={pct(p.approved_minutes - p.invoiced_minutes, p)}></span>
										<span class="bg-amber-400 transition-[width] duration-700 ease-spring" style:width={pct(p.minutes - p.approved_minutes, p)}></span>
									</div>
									<span class="badge {st.cls} mt-1.5">{st.label}</span>
									{#if p.minutes > p.approved_minutes && submitted(p.user_id)}<span class="badge badge-blue mt-1.5">{t('teamPage.submitted')}</span>{/if}
								</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(p.minutes)}</td>
								{#if money}
									<td class="px-3 py-2 text-right tabular-nums">{formatCents(p.cost_cents)}</td>
									<td class="px-3 py-2 text-right tabular-nums">{formatCents(p.revenue_cents)}</td>
								{/if}
								{#if canApprove}
									<td class="whitespace-nowrap px-3 py-2 text-right">
										{#if p.minutes > p.approved_minutes}
											{#if approvable(p.user_id)}
												<button class="btn-primary px-3 py-1.5 text-xs" disabled={busy} onclick={() => approve(true, p.user_id)}>{t('teamPage.approve')}</button>
											{:else}
												<span class="mr-1 text-xs text-zinc-500">{t('teamPage.notSubmitted')}</span>
											{/if}
											<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => reject(p.user_id, p.user_name)}>{t('teamPage.reject')}</button>
										{:else if p.approved_minutes > p.invoiced_minutes}
											<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => approve(false, p.user_id)}>{t('teamPage.unapprove')}</button>
										{/if}
									</td>
								{/if}
							</tr>
						{:else}
							<tr><td colspan="7"><EmptyState icon="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" title={t('teamPage.empty')} /></td></tr>
						{/each}
					</tbody>
					{#if people.length > 1}
						<tfoot>
							<tr class="border-t border-zinc-200 bg-zinc-50/60 font-semibold dark:border-zinc-700 dark:bg-zinc-800/60">
								<td class="px-3 py-2">{t('teamPage.sum')}</td>
								<td class="px-3 py-2 text-xs font-normal tabular-nums text-zinc-500 dark:text-zinc-400">
									{tp('teamPage.totals', { invoiced: hours(totals.invoiced), approved: hours(totals.approved - totals.invoiced), open: hours(totals.minutes - totals.approved) })}
								</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(totals.minutes)}</td>
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
				{t('teamPage.note')}{money ? t('teamPage.noteMoney') : ''}
			</p>
		</section>

		{#if canApprove}
			<section class="card space-y-3">
				<h2 class="text-base font-semibold tracking-tight">{t('teamPage.otherPendingTitle')}</h2>
				{#if otherPending.length}
					<ul class="divide-y divide-zinc-100 dark:divide-zinc-700/70" data-testid="pending-approvals">
						{#each otherPending as p (`${p.user_id}|${p.month}`)}
							<li class="flex items-center justify-between gap-3 py-2 text-sm">
								<span>
									<strong>{p.user_name}</strong> · {team.monthLabel(p.month)}
									<span class="tabular-nums text-zinc-500">{tp('teamPage.pendingEntries', { hours: hours(p.minutes), entries: p.entries })}</span>
									{#if p.submitted_at}<span class="badge badge-blue ml-1">{t('teamPage.submitted')}</span>{/if}
								</span>
								<span class="flex gap-1.5 whitespace-nowrap">
									{#if approvable(p.user_id, p.month)}
										<button class="btn-primary px-3 py-1.5 text-xs" disabled={busy} onclick={() => approve(true, p.user_id, p.month)}>{t('teamPage.approve')}</button>
									{:else}
										<span class="self-center text-xs text-zinc-500">{t('teamPage.notSubmitted')}</span>
									{/if}
									<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => reject(p.user_id, p.user_name, p.month)}>{t('teamPage.reject')}</button>
								</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
						{t('teamPage.noOtherPending')}
					</p>
				{/if}
			</section>
		{/if}

		{#if canFeed}
			<div data-testid="team-activity">
				{#key feedKey}
					<ActivityFeed limit={30} paged projectName={(id) => projectNames.get(id) ?? `#${id}`} />
				{/key}
			</div>
		{/if}
	</section>
{/if}

<Dialog open={rejectTarget !== null} title={t('teamPage.rejectTitle')} size="sm" onclose={() => (rejectTarget = null)}>
	{#if rejectTarget}
		<form
			id="reject-form"
			class="space-y-1.5"
			onsubmit={(e) => {
				e.preventDefault();
				confirmReject();
			}}
		>
			<label for="reject-reason" class="label">{tp('teamPage.rejectQuestion', { name: rejectTarget.name, month: team.monthLabel(rejectTarget.m) })}</label>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea id="reject-reason" rows="3" autofocus class="input-base input-valid rounded-lg" bind:value={rejectReason}></textarea>
			<p class="text-xs text-zinc-500 dark:text-zinc-400">{t('teamPage.reasonMailed')}</p>
		</form>
	{/if}
	{#snippet footer()}
		<button type="button" class="btn-secondary" onclick={() => (rejectTarget = null)}>{t('common.cancel')}</button>
		<button type="submit" form="reject-form" class="btn-primary" disabled={!rejectReason.trim()}>{t('teamPage.reject')}</button>
	{/snippet}
</Dialog>
