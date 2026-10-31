<script lang="ts">
	import { refreshMe, session } from '$lib/session.svelte';
	// Cloud mode, invited members/subcontractors: whose company the hours go to
	// and the caller's own hours per project for one month.
	import { onMount } from 'svelte';
	import TextInput from './TextInput.svelte';
	import { cloud, type Me } from '$lib/cloud';
	import { messageForUnknown } from '$lib/shared/errors';
	import * as team from '$lib/team';

	const ROLES = { admin: 'Admin', member: 'Mitglied', subcontractor: 'Subunternehmer' };
	const hours = (min: number) => (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 });

	let me = $state<Me | null>(null);
	let month = $state(new Date().toISOString().slice(0, 7));
	let rows = $state<team.HoursRow[]>([]);
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

	$effect(() => {
		if (!active || active.role === 'admin' || !/^\d{4}-\d{2}$/.test(month)) return;
		team
			.myHours(month)
			.then((r) => ((rows = r), (error = '')))
			.catch((e) => (error = messageForUnknown(e)));
	});
</script>

{#if active && active.role !== 'admin'}
	<section class="card space-y-3" data-testid="cloud-work-context">
		<p class="text-sm">
			Du arbeitest für <strong>{active.name}</strong> als {ROLES[active.role]}. Deine Zeiten
			gehen an diese Firma{active.role === 'subcontractor'
				? '; du siehst nur Projekte, denen sie dich zugewiesen hat'
				: ''}.
		</p>
		{#if !active.paid}
			<p class="text-sm text-amber-700 dark:text-amber-400">
				Das Abo von {active.name} ist nicht aktiv. Bitte wende dich an die Firma.
			</p>
		{/if}
		<div class="flex items-end gap-3">
			<TextInput bind:value={month} label="Meine Stunden im Monat" type="month" />
			<p class="pb-2 text-sm text-zinc-600 dark:text-zinc-300">
				{hours(total)} h, davon {hours(approved)} h freigegeben
			</p>
		</div>
		{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
		{#if rows.length > 0}
			<div class="table-scroll">
				<table class="w-full text-sm">
					<thead class="table-head">
						<tr>
							<th class="px-3 py-2 text-left">Projekt</th>
							<th class="px-3 py-2 text-right">Stunden</th>
							<th class="px-3 py-2 text-right">davon freigegeben</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as r (r.project_id)}
							<tr class="data-row">
								<td class="px-3 py-2">{r.project_name ?? '–'}</td>
								<td class="px-3 py-2 text-right">{hours(r.minutes)}</td>
								<td class="px-3 py-2 text-right">{hours(r.approved_minutes)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}
