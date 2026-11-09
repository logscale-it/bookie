<script lang="ts">
	import { refreshMe, session } from '$lib/session.svelte';
	// Cloud mode, invited members/subcontractors: whose company the hours go to
	// and the caller's own hours per project for one month.
	import { onMount } from 'svelte';
	import TextInput from './TextInput.svelte';
	import { cloud, type Me } from '$lib/cloud';
	import { messageForUnknown } from '$lib/shared/errors';
	import * as team from '$lib/team';
	import { getLocaleFormatting, t, tp } from '$lib/i18n';

	const ROLES = { admin: 'shell.roleAdmin', member: 'shell.roleMember', subcontractor: 'shell.roleSubcontractor' };
	const hours = (min: number) => (min / 60).toLocaleString(getLocaleFormatting(), { maximumFractionDigits: 2 });

	let me = $state<Me | null>(null);
	let month = $state(new Date().toISOString().slice(0, 7));
	let rows = $state<team.HoursRow[]>([]);
	let rejection = $state<team.Rejection | null>(null);
	let submittedAt = $state<string | null>(null);
	let busy = $state(false);
	let error = $state('');

	const active = $derived(me?.companies.find((c) => c.id === me?.activeCompanyId));
	const total = $derived(rows.reduce((n, r) => n + r.minutes, 0));
	const approved = $derived(rows.reduce((n, r) => n + r.approved_minutes, 0));

	onMount(async () => {
		if (!cloud()) return;
		try {
			me = session.me ?? (await refreshMe());
		} catch (e) {
			error = messageForUnknown(e);
		}
	});

	const load = () =>
		team
			.myHours(month)
			.then((r) => ((rows = r.projects), (rejection = r.rejection), (submittedAt = r.submitted_at), (error = '')))
			.catch((e) => (error = messageForUnknown(e)));

	async function submit() {
		busy = true;
		try {
			await team.submitMonth(month);
			await load();
		} catch (e) {
			error = messageForUnknown(e);
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		if (!active || active.role === 'admin' || !/^\d{4}-\d{2}$/.test(month)) return;
		load();
	});
</script>

{#if active && active.role !== 'admin'}
	<section class="card space-y-3" data-testid="cloud-work-context">
		<p class="text-sm">
			{t('workContext.introLead')} <strong>{active.name}</strong>
			{tp('workContext.introRole', { role: t(ROLES[active.role]) })}{active.role === 'subcontractor' ? t('workContext.introSubScope') : ''}.
		</p>
		{#if active.role === 'subcontractor' && !me?.companies.some((c) => c.role === 'admin')}
			<p class="text-sm text-zinc-600 dark:text-zinc-300" data-testid="own-company-hint">
				{tp('workContext.ownCompanyLead', { name: active.name })}
				<a href="/einstellungen/cloud" class="font-medium text-accent-700 underline dark:text-accent-300">{t('workContext.ownCompanyLink')}</a>
				{t('workContext.ownCompanyRest')}
			</p>
		{/if}
		{#if !active.paid}
			<p class="text-sm text-amber-700 dark:text-amber-400">
				{tp('workContext.unpaid', { name: active.name })}
			</p>
		{/if}
		<div class="flex items-end gap-3">
			<TextInput bind:value={month} label={t('workContext.monthHours')} type="month" />
			<p class="pb-2 text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
				{tp('workContext.hoursSummary', { total: hours(total), approved: hours(approved) })}
			</p>
			{#if submittedAt}
				<span class="badge badge-blue mb-2">{t('workContext.submitted')}</span>
			{:else if total > approved}
				<button class="btn-primary mb-1 px-3 py-1.5 text-xs" disabled={busy} onclick={submit}>{t('workContext.submit')}</button>
			{/if}
		</div>
		{#if submittedAt}
			<p class="text-xs text-zinc-500">{t('workContext.submittedNote')}</p>
		{/if}
		{#if rejection}
			<p class="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20" data-testid="month-rejected">
				{tp('workContext.rejected', { by: rejection.by, month: team.monthLabel(month), reason: rejection.reason })}
			</p>
		{/if}
		{#if error}<p class="text-sm text-red-600 dark:text-red-400">{error}</p>{/if}
		{#if rows.length > 0}
			<div class="table-scroll overflow-hidden rounded-lg ring-1 ring-zinc-900/5 dark:ring-white/10">
				<table class="w-full text-sm">
					<thead class="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
						<tr>
							<th class="px-3 py-2 text-left">{t('workContext.colProject')}</th>
							<th class="px-3 py-2 text-right">{t('workContext.colHours')}</th>
							<th class="px-3 py-2 text-right">{t('workContext.colApproved')}</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as r (r.project_id)}
							<tr class="border-b border-zinc-100 text-zinc-700 transition duration-200 ease-spring last:border-0 hover:bg-zinc-50/70 dark:border-zinc-700/70 dark:text-zinc-200 dark:hover:bg-white/[0.02]">
								<td class="px-3 py-2">{r.project_name ?? '–'}</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(r.minutes)}</td>
								<td class="px-3 py-2 text-right tabular-nums">{hours(r.approved_minutes)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}
