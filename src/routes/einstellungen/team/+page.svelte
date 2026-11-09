<script lang="ts">
	import { can, refreshMe } from '$lib/session.svelte';
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
	import { getLocaleFormatting, t, tp } from '$lib/i18n';

	const MESSAGES: Record<string, string> = {
		invalid_input: 'teamSettings.errInvalidInput',
		invalid_token: 'teamSettings.errInvalidToken',
		wrong_account: 'teamSettings.errWrongAccount',
		already_member: 'teamSettings.errAlreadyMember',
		too_many_requests: 'teamSettings.errTooManyRequests',
		rejected: 'teamSettings.errRejected',
		not_found: 'teamSettings.errNotFound',
		no_grants_for_role: 'teamSettings.errNoGrantsForRole',
		not_a_member: 'teamSettings.errNotAMember'
	};
	const message = (e: unknown) =>
		(e instanceof CloudError && MESSAGES[e.code] && t(MESSAGES[e.code])) || messageForUnknown(e);
	const ROLES: Record<team.Role, string> = {
		admin: 'shell.roleAdmin',
		member: 'shell.roleMember',
		subcontractor: 'shell.roleSubcontractor'
	};
	const areaLabel = (a: team.Area) => t(`feed.areas.${a}`);
	type GrantLevel = '' | team.Grant['level'];
	const eur = (cents: number | null) => (cents == null ? '' : String(cents / 100).replace('.', ','));
	const day = (iso: string) => new Date(iso).toLocaleDateString(getLocaleFormatting());
	const INVITE_STATUS: Record<team.Invitation['status'], [string, string]> = {
		pending: ['teamSettings.statusPending', 'badge-amber'],
		accepted: ['teamSettings.statusAccepted', 'badge-green'],
		expired: ['teamSettings.statusExpired', 'badge-zinc']
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
		}, t('teamSettings.inviteSent'));

	const revoke = (i: team.Invitation) => {
		const before = invitations;
		deferDelete({
			message: tp(i.status === 'pending' ? 'teamSettings.inviteRevoked' : 'teamSettings.inviteRemoved', { email: i.email }),
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
		}, t('teamSettings.rateSaved'));

	const saveGrants = (userId: number) =>
		run(async () => {
			const g = grants[userId];
			await team.setGrants(
				userId,
				team.AREAS.flatMap((area) => (g[area] ? [{ area, level: g[area] }] : []))
			);
			await load();
		}, t('teamSettings.grantsSaved'));

	const changeRole = (m: team.TeamMember, select: HTMLSelectElement) => {
		const role = select.value as 'member' | 'subcontractor';
		const go = () =>
			run(async () => {
				await team.setRole(m.user_id, role);
				await load();
			}, t('teamSettings.roleChanged'));
		if (role === 'subcontractor' && m.grants.length > 0) {
			ask = {
				title: t('teamSettings.changeRole'),
				body: tp('teamSettings.changeRoleBody', { name: m.name }),
				label: t('teamSettings.changeRole'),
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
			title: t('teamSettings.handOverTitle'),
			body: tp('teamSettings.handOverBody', { name: m.name, company: active?.name ?? '' }),
			label: t('teamSettings.makeAdmin'),
			ok: () =>
				run(async () => {
					await team.makeAdmin(m.user_id);
					location.reload();
				})
		};
	};

	const remove = (m: team.TeamMember) => {
		ask = {
			title: t('teamSettings.removeTitle'),
			body: tp('teamSettings.removeBody', { name: m.name }),
			label: t('teamSettings.remove'),
			danger: true,
			ok: () =>
				run(async () => {
					await team.removeMember(m.user_id);
					await load();
				}, t('teamSettings.removed'))
		};
	};

</script>

{#if !session}
	<section class="card">
		<p class="text-sm">{t('teamSettings.cloudOnly')}</p>
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
				<SectionHead eyebrow={t('teamSettings.seatsEyebrow')} title={t('teamSettings.seatsTitle')} />
				<p class="text-sm">
					<strong>{tp(members.length === 1 ? 'teamSettings.seatOne' : 'teamSettings.seatMany', { count: members.length })}</strong>
					{tp('teamSettings.seatsRest', {
						company: active?.name ?? '',
						admins: members.filter((m) => m.role === 'admin').length,
						members: members.filter((m) => m.role === 'member').length,
						subs: subs.length
					})}
				</p>
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					{tp('teamSettings.seatsInfo', { pending })}
					<a class="font-medium text-accent-600 hover:underline dark:text-accent-400" href="/einstellungen/cloud">{t('teamSettings.seatsLink')}</a>.
				</p>
			</section>
		{/if}

		{#if active && active.role !== 'subcontractor' && (can('team_time') || can('reports'))}
			<section class="card space-y-3 p-5">
				<SectionHead eyebrow={t('teamSettings.hoursEyebrow')} title={t('teamSettings.hoursTitle')} />
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					{t('teamSettings.hoursLead')}
					<a class="font-medium text-accent-600 hover:underline dark:text-accent-400" href="/team">{t('nav.team')}</a>{t('teamSettings.hoursMid')}
					<a class="font-medium text-accent-600 hover:underline dark:text-accent-400" href="/projekte">{t('nav.projects')}</a> {t('teamSettings.hoursRest')}
				</p>
			</section>
		{/if}

		{#if admin}
			<section class="card space-y-4 p-5">
				<SectionHead eyebrow={t('nav.team')} title={t('teamSettings.membersTitle')} desc={t('teamSettings.membersDesc')} />
				<div class="table-scroll overflow-hidden rounded-lg ring-1 ring-zinc-900/5 dark:ring-white/10">
					<table class="w-full text-sm">
						<thead class="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
							<tr>
								<th class="px-3 py-2 text-left">{t('common.name')}</th>
								<th class="px-3 py-2 text-left">{t('teamSettings.email')}</th>
								<th class="px-3 py-2 text-left">{t('teamSettings.role')}</th>
								<th class="px-3 py-2 text-left">{t('teamSettings.rateHeader')}</th>
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
											<span class="badge badge-zinc">{t(ROLES[m.role])}</span>
										{:else}
											<select
												class="input-base input-valid rounded-lg py-1.5"
												aria-label={t('teamSettings.role')}
												disabled={busy}
												value={m.role}
												onchange={(e) => changeRole(m, e.currentTarget)}
											>
												<option value="member">{t(ROLES.member)}</option>
												<option value="subcontractor">{t(ROLES.subcontractor)}</option>
											</select>
										{/if}
									</td>
									<td class="px-3 py-2">
										{#if m.role === 'subcontractor'}
											<div class="flex gap-2">
												<input
													class="input-base input-valid w-28 rounded-lg py-1.5 tabular-nums"
													inputmode="decimal"
													aria-label={t('teamSettings.rate')}
													bind:value={rates[m.user_id]}
												/>
												<button
													class="btn-secondary px-3 py-1.5 text-xs"
													disabled={busy}
													onclick={() => saveRate(m.user_id)}>{t('common.save')}</button
												>
											</div>
										{/if}
									</td>
									<td class="whitespace-nowrap px-3 py-2 text-right">
										{#if m.role === 'member'}
											<button class="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onclick={() => handOver(m)}
												>{t('teamSettings.makeAdmin')}</button
											>
										{/if}
										{#if m.role !== 'admin'}
											<button class="icon-btn icon-btn-danger" disabled={busy} onclick={() => remove(m)} title={t('teamSettings.remove')} aria-label={tp('teamSettings.removeAria', { name: m.name })}>
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
															>{areaLabel(area)}</label
														>
														<select
															id={`grant-${m.user_id}-${area}`}
															class="input-base input-valid rounded-lg py-1.5"
															bind:value={grants[m.user_id][area]}
														>
															<option value="">{t('teamSettings.noAccess')}</option>
															<option value="view">{t('teamSettings.levelView')}</option>
															<option value="edit">{t('common.edit')}</option>
														</select>
													</div>
												{/each}
												<button
													class="btn-secondary px-3 py-1.5 text-xs"
													disabled={busy}
													onclick={() => saveGrants(m.user_id)}>{t('teamSettings.saveGrants')}</button
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
				<SectionHead eyebrow={t('teamSettings.inviteEyebrow')} title={t('teamSettings.inviteTitle')} desc={t('teamSettings.inviteDesc')} />
				<div class="grid gap-3 sm:grid-cols-3">
					<TextInput bind:value={inviteEmail} label={t('teamSettings.email')} type="email" />
					<div class="flex flex-col gap-1.5">
						<label for="invite-role" class="label">{t('teamSettings.role')}</label>
						<select id="invite-role" class="input-base input-valid rounded-lg py-1.5" bind:value={inviteRole}>
							<option value="member">{t('shell.roleMember')}</option>
							<option value="subcontractor">{t('shell.roleSubcontractor')}</option>
						</select>
					</div>
					{#if inviteRole === 'subcontractor'}
						<TextInput bind:value={inviteRate} label={t('teamSettings.rateHeader')} placeholder={t('teamSettings.ratePlaceholder')} />
					{:else}
						<div class="flex flex-col gap-1.5">
							<label for="invite-preset" class="label">{t('teamSettings.rights')}</label>
							<select id="invite-preset" class="input-base input-valid rounded-lg py-1.5" bind:value={invitePreset}>
								{#each Object.entries(team.PRESETS) as [key, p] (key)}
									<option value={key}>{t(p.label)}</option>
								{/each}
							</select>
						</div>
					{/if}
				</div>
				<button class="btn-primary" disabled={busy || !inviteEmail.trim()} onclick={sendInvite}
					>{t('teamSettings.sendInvite')}</button
				>
				{#if invitations.length > 0}
					<div class="table-scroll overflow-hidden rounded-lg ring-1 ring-zinc-900/5 dark:ring-white/10">
						<table class="w-full text-sm">
							<thead class="border-b border-zinc-200 bg-zinc-50 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
								<tr>
									<th class="px-3 py-2 text-left">{t('teamSettings.email')}</th>
									<th class="px-3 py-2 text-left">{t('teamSettings.role')}</th>
									<th class="px-3 py-2 text-left">{t('common.status')}</th>
									<th class="px-3 py-2 text-left">{t('teamSettings.validUntil')}</th>
									<th class="px-3 py-2"></th>
								</tr>
							</thead>
							<tbody>
								{#each invitations as i (i.id)}
									<tr class="border-b border-zinc-100 text-zinc-700 transition duration-200 ease-spring hover:bg-zinc-50/70 dark:border-zinc-700/70 dark:text-zinc-200 dark:hover:bg-white/[0.02]">
										<td class="px-3 py-2">{i.email}</td>
										<td class="px-3 py-2">
											{t(ROLES[i.role])}{#if i.grants.length}
												<span class="text-zinc-500">
													· {i.grants.map((g) => `${areaLabel(g.area)}${g.level === 'view' ? t('feed.readOnly') : ''}`).join(', ')}</span
												>
											{/if}{#if i.cost_rate_cents != null}
												<span class="text-zinc-500"> · {formatCents(i.cost_rate_cents)}/h</span>
											{/if}
										</td>
										<td class="px-3 py-2">
											<span class={`badge ${INVITE_STATUS[i.status][1]}`}
												>{t(INVITE_STATUS[i.status][0])}</span
											>
										</td>
										<td class="px-3 py-2 tabular-nums">
											{i.status === 'accepted' && i.accepted_at
												? tp('teamSettings.acceptedOn', { date: day(i.accepted_at) })
												: day(i.expires_at)}
										</td>
										<td class="px-3 py-2 text-right">
											{#if i.status !== 'accepted'}
												<button class="icon-btn icon-btn-danger" disabled={busy} onclick={() => revoke(i)} title={t(i.status === 'pending' ? 'teamSettings.revoke' : 'teamSettings.remove')} aria-label={t(i.status === 'pending' ? 'teamSettings.revoke' : 'teamSettings.remove')}>
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
			<SectionHead eyebrow={t('teamSettings.joinEyebrow')} title={t('teamSettings.joinTitle')} desc={t('teamSettings.joinDesc')} />
			<TextInput bind:value={token} label={t('teamSettings.tokenLabel')} />
			<button class="btn-primary" disabled={busy || !token.trim()} onclick={accept}>{t('teamSettings.accept')}</button>
		</section>
	</div>
{/if}

<Dialog open={ask !== null} title={ask?.title} size="sm" onclose={closeAsk}>
	<p class="text-sm text-zinc-600 dark:text-zinc-300">{ask?.body}</p>
	{#snippet footer()}
		<button type="button" class="btn-secondary" onclick={closeAsk}>{t('common.cancel')}</button>
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
