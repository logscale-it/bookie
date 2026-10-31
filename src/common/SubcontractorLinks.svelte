<script lang="ts">
	import { refreshMe, session } from '$lib/session.svelte';
	// Cloud mode, own company (admin): client projects the caller works on as a
	// subcontractor elsewhere. Linking one to an own project mirrors those hours
	// here, read-only, invoiceable once the client approved them.
	import { onMount } from 'svelte';
	import { cloud, type Me } from '$lib/cloud';
	import type { Project } from '$lib/db/types';
	import { messageForUnknown } from '$lib/shared/errors';
	import * as team from '$lib/team';

	let { projects }: { projects: Project[] } = $props();

	let me = $state<Me | null>(null);
	let rows = $state<team.Assignment[]>([]);
	let busy = $state(false);
	let info = $state('');
	let error = $state('');

	const activeId = $derived(me?.activeCompanyId ?? null);

	async function load() {
		rows = await team.myAssignments();
	}

	onMount(async () => {
		if (!cloud()) return;
		try {
			me = session.me ?? (await refreshMe());
			if (me.companies.find((c) => c.id === me?.activeCompanyId)?.role === 'admin') await load();
		} catch (e) {
			error = messageForUnknown(e);
		}
	});

	async function change(row: team.Assignment, value: string) {
		busy = true;
		info = error = '';
		try {
			if (value) {
				const r = await team.linkProject(row.project_id, Number(value));
				info = `${r.mirrored} Zeiteinträge übernommen.`;
			} else {
				await team.unlinkProject(row.project_id);
				info = 'Verknüpfung gelöst; bereits abgerechnete Einträge bleiben.';
			}
			await load();
		} catch (e) {
			error =
				(e as { code?: string }).code === 'linked_elsewhere'
					? 'Dieses Projekt ist schon mit einer anderen eigenen Firma verknüpft. Löse die Verknüpfung dort zuerst.'
					: messageForUnknown(e);
			await load().catch(() => {});
		} finally {
			busy = false;
		}
	}
</script>

{#if rows.length > 0}
	<section class="card space-y-3" data-testid="subcontractor-links">
		<div>
			<h2 class="font-semibold">Aufträge als Subunternehmer</h2>
			<p class="text-sm text-zinc-600 dark:text-zinc-300">
				Verknüpfe ein Projekt deines Auftraggebers mit einem eigenen Projekt (eigener Stundensatz,
				Kunde = Auftraggeber). Deine dort gebuchten Stunden erscheinen dann hier in der
				Zeiterfassung und sind abrechenbar, sobald der Auftraggeber sie freigegeben hat.
			</p>
		</div>
		<div class="table-scroll">
			<table class="w-full text-sm">
				<thead class="table-head">
					<tr>
						<th class="px-3 py-2 text-left">Auftraggeber</th>
						<th class="px-3 py-2 text-left">Projekt</th>
						<th class="px-3 py-2 text-left">Eigenes Projekt</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.project_id)}
						<tr class="data-row">
							<td class="px-3 py-2">{row.company_name}</td>
							<td class="px-3 py-2">{row.project_name}</td>
							<td class="px-3 py-2">
								{#if row.linked_company_id != null && row.linked_company_id !== activeId}
									<span class="text-zinc-500">in einer anderen eigenen Firma verknüpft</span>
								{:else}
									<select
										aria-label="Eigenes Projekt für {row.project_name}"
										class="input-base input-valid cursor-pointer pr-8"
										value={row.linked_project_id == null ? '' : String(row.linked_project_id)}
										disabled={busy}
										onchange={(e) => change(row, e.currentTarget.value)}
									>
										<option value="">— nicht verknüpft —</option>
										{#each projects as p (p.id)}
											<option value={String(p.id)}>{p.name}</option>
										{/each}
									</select>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if info}<p class="text-sm text-zinc-600 dark:text-zinc-300">{info}</p>{/if}
		{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
	</section>
{/if}
