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
	import { t, tp } from '$lib/i18n';

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
				info = tp('subLinks.mirrored', { count: r.mirrored });
			} else {
				await team.unlinkProject(row.project_id);
				info = t('subLinks.unlinked');
			}
			await load();
		} catch (e) {
			error =
				(e as { code?: string }).code === 'linked_elsewhere'
					? t('subLinks.linkedElsewhereError')
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
			<h2 class="text-base font-semibold tracking-tight">{t('subLinks.title')}</h2>
			<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
				{t('subLinks.intro')}
			</p>
		</div>
		<div class="table-scroll overflow-hidden rounded-lg ring-1 ring-zinc-900/5 dark:ring-white/10">
			<table class="w-full text-sm">
				<thead class="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
					<tr>
						<th class="px-3 py-2 text-left">{t('subLinks.colClient')}</th>
						<th class="px-3 py-2 text-left">{t('subLinks.colProject')}</th>
						<th class="px-3 py-2 text-left">{t('subLinks.colOwnProject')}</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.project_id)}
						<tr class="border-b border-zinc-100 text-zinc-700 transition duration-200 ease-spring last:border-0 hover:bg-zinc-50/70 dark:border-zinc-700/70 dark:text-zinc-200 dark:hover:bg-white/[0.02]">
							<td class="px-3 py-2">{row.company_name}</td>
							<td class="px-3 py-2">{row.project_name}</td>
							<td class="px-3 py-2">
								{#if row.linked_company_id != null && row.linked_company_id !== activeId}
									<span class="text-zinc-500">{t('subLinks.linkedElsewhere')}</span>
								{:else}
									<select
										aria-label={tp('subLinks.selectLabel', { name: row.project_name })}
										class="input-base input-valid cursor-pointer rounded-lg py-1.5 pr-8"
										value={row.linked_project_id == null ? '' : String(row.linked_project_id)}
										disabled={busy}
										onchange={(e) => change(row, e.currentTarget.value)}
									>
										<option value="">{t('subLinks.notLinked')}</option>
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
		{#if error}<p class="text-sm text-red-600 dark:text-red-400">{error}</p>{/if}
	</section>
{/if}
