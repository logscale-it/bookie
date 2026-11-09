<script lang="ts">
	// Cloud mode only: vacation requests. Members and leads request days off and
	// see their own requests; the admin also sees the whole team's and approves or
	// rejects them (with a reason, mailed). Subcontractors are not employees: the
	// nav hides this page for them and the server refuses every leave route.
	import { isAdmin, isSub, session } from '$lib/session.svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { cloud, CloudError } from '$lib/cloud';
	import CloudTeaser from '../../common/CloudTeaser.svelte';
	import { messageForUnknown } from '$lib/shared/errors';
	import * as team from '$lib/team';
	import Dialog from '../../common/Dialog.svelte';
	import DateInput from '../../common/DateInput.svelte';
	import SkeletonRows from '../../common/SkeletonRows.svelte';
	import EmptyState from '../../common/EmptyState.svelte';
	import Avatar from '../../common/Avatar.svelte';
	import { t, tp } from '$lib/i18n';

	const MESSAGES: Record<string, string> = {
		invalid_input: 'leave.errInvalidInput',
		overlap: 'leave.errOverlap',
		not_pending: 'leave.errNotPending'
	};
	const message = (e: unknown) => (e instanceof CloudError && MESSAGES[e.code] && t(MESSAGES[e.code])) || messageForUnknown(e);
	const STATUS = {
		pending: { label: 'leave.statusPending', cls: 'badge-amber' },
		approved: { label: 'leave.statusApproved', cls: 'badge-green' },
		rejected: { label: 'leave.statusRejected', cls: 'badge-red' }
	} as const;
	const ICON =
		'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5';
	const enter = (i: number) => ({ y: 12, duration: 520, delay: Math.min(i, 8) * 40, easing: cubicOut });
	const span = (r: { start_date: string; end_date: string }) =>
		r.start_date === r.end_date ? team.dayLabel(r.start_date) : `${team.dayLabel(r.start_date)} – ${team.dayLabel(r.end_date)}`;
	const days = (r: { start_date: string; end_date: string }) => {
		const n = team.workdays(r.start_date, r.end_date);
		return tp(n === 1 ? 'leave.workday' : 'leave.workdays', { count: n });
	};

	// session.me is the dependency (cloud() reads localStorage, not reactive).
	const isCloud = $derived(!!session.me && !!cloud() && !isSub());
	const admin = $derived(!!session.me && isAdmin());
	const today = new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
	const year = today.slice(0, 4);

	let rows = $state<team.LeaveRequest[]>([]);
	let loaded = $state(false);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let start = $state('');
	let end = $state('');
	let note = $state('');
	let rejectTarget = $state<team.LeaveRequest | null>(null);
	let rejectReason = $state('');
	let deleteTarget = $state<team.LeaveRequest | null>(null); // approved leave: ask first

	const me = $derived(session.me?.user.id);
	const mine = $derived(rows.filter((r) => r.user_id === me));
	const pending = $derived(admin ? rows.filter((r) => r.status === 'pending') : []);
	const history = $derived(admin ? rows : mine);
	const valid = $derived(!!start && !!end && end >= start);
	const preview = $derived(valid ? team.workdays(start, end) : 0);
	const sum = (list: team.LeaveRequest[]) =>
		list.reduce((n, r) => n + team.workdays(r.start_date < `${year}-01-01` ? `${year}-01-01` : r.start_date, r.end_date > `${year}-12-31` ? `${year}-12-31` : r.end_date), 0);
	const approvedDays = $derived(sum(mine.filter((r) => r.status === 'approved' && r.end_date >= `${year}-01-01` && r.start_date <= `${year}-12-31`)));
	const openDays = $derived(mine.filter((r) => r.status === 'pending').reduce((n, r) => n + team.workdays(r.start_date, r.end_date), 0));
	const next = $derived(
		mine.filter((r) => r.status === 'approved' && r.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date))[0]
	);

	const load = async () => (rows = await team.listLeave());
	let started = false;
	$effect(() => {
		if (!isCloud || started) return;
		started = true;
		run(load).finally(() => (loaded = true));
	});

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

	const submit = () =>
		run(async () => {
			await team.requestLeave(start, end, note);
			notice = tp('leave.requested', { span: span({ start_date: start, end_date: end }) });
			start = end = note = '';
			await load();
		});

	const decide = (r: team.LeaveRequest, approve: boolean, reason = '') =>
		run(async () => {
			await team.decideLeave(r.id, approve, reason);
			notice = tp(approve ? 'leave.approvedOf' : 'leave.rejectedOf', { name: r.user_name });
			await load();
		});

	const remove = (r: team.LeaveRequest) =>
		run(async () => {
			await team.deleteLeave(r.id);
			notice = tp('leave.deleted', { span: span(r) });
			await load();
		});

	const confirmReject = () => {
		const reason = rejectReason.trim();
		if (!rejectTarget || !reason) return;
		const r = rejectTarget;
		rejectTarget = null;
		decide(r, false, reason);
	};
</script>

{#if !isCloud}
	<CloudTeaser
		title={t('nav.leave')}
		points={[t('leave.teaser1'), t('leave.teaser2'), t('leave.teaser3')]}
	/>
{:else}
	<section class="space-y-8">
		<header class="flex flex-wrap items-end justify-between gap-4">
			<div>
				<span class="inline-flex rounded-full bg-accent-500/10 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-accent-700 ring-1 ring-accent-600/15 dark:text-accent-300">
					{t('leave.eyebrow')}
				</span>
				<h1 class="page-header mt-2">{t('nav.leave')}</h1>
				<p class="mt-1 max-w-xl text-sm text-zinc-500 dark:text-zinc-400">
					{admin
						? tp('leave.introAdmin', { name: session.company?.name ?? t('leave.yourTeam') })
						: t('leave.intro')}
				</p>
			</div>
		</header>

		<!-- KPI strip: own days this year -->
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="leave-stats">
			{#each [
				{ k: tp('leave.statApproved', { year }), v: `${approvedDays}`, u: t(approvedDays === 1 ? 'leave.day' : 'leave.days') },
				{ k: t('leave.statOpen'), v: `${openDays}`, u: t(openDays === 1 ? 'leave.day' : 'leave.days') },
				{ k: t('leave.statNext'), v: next ? team.dayLabel(next.start_date) : '–', u: next ? days(next) : t('leave.nothingPlanned') }
			] as s, i (s.k)}
				<div class="bezel" in:fly={enter(i)}>
					<div class="bezel-core">
						<p class="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">{s.k}</p>
						<p class="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">{s.v}</p>
						<p class="text-xs text-zinc-500 dark:text-zinc-400">{s.u}</p>
					</div>
				</div>
			{/each}
		</div>

		{#if error}<p role="alert" class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-600/10 dark:bg-red-950/40 dark:text-red-300">{error}</p>{/if}
		{#if notice}<p class="animate-pop rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-600/10 dark:bg-emerald-950/40 dark:text-emerald-300">{notice}</p>{/if}

		<div class="grid grid-cols-1 gap-6 lg:grid-cols-12">
			<!-- Request form -->
			<form
				class="bezel lg:col-span-5 lg:self-start"
				onsubmit={(e) => {
					e.preventDefault();
					if (valid) submit();
				}}
			>
				<div class="bezel-core space-y-4">
					<h2 class="text-base font-semibold tracking-tight">{t('leave.request')}</h2>
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<DateInput id="leave-start" label={t('leave.firstDay')} bind:value={start} />
						<DateInput id="leave-end" label={t('leave.lastDay')} bind:value={end} min={start} error={start && end && end < start ? t('leave.beforeFirst') : ''} />
					</div>
					<div class="flex flex-col gap-1.5">
						<label for="leave-note" class="label">{t('leave.note')}</label>
						<textarea id="leave-note" rows="2" maxlength="1000" class="input-base input-valid rounded-lg" placeholder={t('leave.notePlaceholder')} bind:value={note}></textarea>
					</div>
					<div class="flex items-center justify-between gap-3">
						<span class="text-sm tabular-nums text-zinc-500 transition-opacity duration-300 ease-spring dark:text-zinc-400 {valid ? 'opacity-100' : 'opacity-0'}" aria-live="polite">
							{valid ? tp(preview === 1 ? 'leave.workday' : 'leave.workdays', { count: preview }) : ''}
						</span>
						<button type="submit" class="group btn-primary rounded-full py-1.5 pr-1.5 pl-4" disabled={!valid || busy}>
							{t('leave.request')}
							<span class="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 transition-transform duration-300 ease-spring group-hover:translate-x-0.5 group-hover:-translate-y-px">
								<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" /></svg>
							</span>
						</button>
					</div>
					<p class="text-xs text-zinc-500 dark:text-zinc-400">{t('leave.countNote')}</p>
				</div>
			</form>

			<div class="space-y-6 lg:col-span-7">
				{#if admin}
					<section class="space-y-3" data-testid="leave-pending">
						<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">{t('leave.pendingTitle')}</h2>
						{#if !loaded}
							<div class="table-card"><SkeletonRows rows={2} cols={3} /></div>
						{:else if pending.length}
							<ul class="space-y-2">
								{#each pending as r, i (r.id)}
									<li class="card flex flex-wrap items-center justify-between gap-3" data-testid="leave-row" in:fly={enter(i)}>
										<div class="flex min-w-0 items-center gap-3">
											<Avatar id={r.user_id} name={r.user_name} />
											<div class="min-w-0">
												<p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.user_name}</p>
												<p class="text-sm tabular-nums text-zinc-600 dark:text-zinc-300">{span(r)} · {days(r)}</p>
												{#if r.note}<p class="truncate text-xs text-zinc-500 dark:text-zinc-400">„{r.note}“</p>{/if}
											</div>
										</div>
										<span class="flex gap-1.5">
											<button class="btn-primary px-3 py-1.5 text-xs" disabled={busy} onclick={() => decide(r, true)}>{t('leave.approve')}</button>
											<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => ((rejectReason = ''), (rejectTarget = r))}>{t('leave.reject')}</button>
										</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
								{t('leave.noPending')}
							</p>
						{/if}
					</section>
				{/if}

				<section class="space-y-3" data-testid="leave-history">
					<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">{t(admin ? 'leave.allRequests' : 'leave.myRequests')}</h2>
					<div class="table-card">
						{#if !loaded}
							<SkeletonRows rows={3} cols={3} />
						{:else}
							<ul class="divide-y divide-zinc-100 dark:divide-zinc-700/70">
								{#each history as r, i (r.id)}
									<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-150 ease-spring hover:bg-zinc-50/70 dark:hover:bg-white/[0.02]" data-testid="leave-row" in:fly={enter(i)}>
										<div class="min-w-0">
											{#if admin}<p class="font-medium text-zinc-900 dark:text-zinc-100">{r.user_name}</p>{/if}
											<p class="tabular-nums text-zinc-700 dark:text-zinc-200">{span(r)} <span class="text-zinc-500">· {days(r)}</span></p>
											{#if r.status === 'rejected' && r.reason}
												<p class="text-xs text-red-700 dark:text-red-300">{tp('leave.rejectedBy', { name: r.decided_by_name ?? '', reason: r.reason })}</p>
											{:else if r.status === 'approved' && r.decided_by_name}
												<p class="text-xs text-zinc-500 dark:text-zinc-400">{tp('leave.approvedBy', { name: r.decided_by_name })}</p>
											{/if}
										</div>
										<span class="flex items-center gap-2">
											<span class="badge {STATUS[r.status].cls}">{t(STATUS[r.status].label)}</span>
											{#if r.user_id === me}
												<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => (r.status === 'approved' ? (deleteTarget = r) : remove(r))}>{t('common.delete')}</button>
											{/if}
										</span>
									</li>
								{:else}
									<li><EmptyState icon={ICON} title={t('leave.empty')} /></li>
								{/each}
							</ul>
						{/if}
					</div>
				</section>
			</div>
		</div>
	</section>
{/if}

<Dialog open={deleteTarget !== null} title={t('leave.deleteTitle')} size="sm" onclose={() => (deleteTarget = null)}>
	{#if deleteTarget}
		<p class="text-sm text-zinc-600 dark:text-zinc-300">
			{tp('leave.deleteBody', { span: span(deleteTarget), days: days(deleteTarget) })}
		</p>
	{/if}
	{#snippet footer()}
		<button type="button" class="btn-secondary" onclick={() => (deleteTarget = null)}>{t('common.cancel')}</button>
		<button
			type="button"
			class="btn-danger"
			onclick={() => {
				const r = deleteTarget;
				deleteTarget = null;
				if (r) remove(r);
			}}>{t('leave.deleteConfirm')}</button>
	{/snippet}
</Dialog>

<Dialog open={rejectTarget !== null} title={t('leave.rejectTitle')} size="sm" onclose={() => (rejectTarget = null)}>
	{#if rejectTarget}
		<form
			id="leave-reject-form"
			class="space-y-1.5"
			onsubmit={(e) => {
				e.preventDefault();
				confirmReject();
			}}
		>
			<label for="leave-reject-reason" class="label">{tp('leave.rejectQuestion', { name: rejectTarget.user_name, span: span(rejectTarget) })}</label>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea id="leave-reject-reason" rows="3" autofocus class="input-base input-valid rounded-lg" bind:value={rejectReason}></textarea>
			<p class="text-xs text-zinc-500 dark:text-zinc-400">{t('teamPage.reasonMailed')}</p>
		</form>
	{/if}
	{#snippet footer()}
		<button type="button" class="btn-secondary" onclick={() => (rejectTarget = null)}>{t('common.cancel')}</button>
		<button type="submit" form="leave-reject-form" class="btn-primary" disabled={!rejectReason.trim()}>{t('leave.reject')}</button>
	{/snippet}
</Dialog>
