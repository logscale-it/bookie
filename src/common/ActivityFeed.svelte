<script lang="ts">
	// Self-loading "Aktivität" card: the latest invoice moves (and in the cloud
	// all team actions, with who did it) as a vertical timeline. Dashboard and
	// Team page share it; `paged` adds "Mehr".
	import { cloud } from '$lib/cloud';
	import { listActivity, type ActivityItem, type ActivityKind } from '$lib/db/activity';
	import { describe } from '$lib/team';
	import Avatar from './Avatar.svelte';
	import { messageForUnknown } from '$lib/shared/errors';
	import EmptyState from './EmptyState.svelte';

	let {
		limit = 8,
		paged = false,
		projectName
	}: { limit?: number; paged?: boolean; projectName?: (id: number) => string } = $props();

	const KIND: Record<ActivityKind, { text: string; dot: string }> = {
		created: { text: 'Rechnungsentwurf angelegt', dot: 'bg-zinc-400 dark:bg-zinc-500' },
		issued: { text: 'Rechnung gestellt', dot: 'bg-accent-500' },
		storno: { text: 'Stornorechnung erstellt', dot: 'bg-amber-500' },
		paid: { text: 'Rechnung bezahlt', dot: 'bg-emerald-500' },
		reopened: { text: 'Zahlung zurückgenommen', dot: 'bg-amber-500' },
		cancelled: { text: 'Rechnung storniert', dot: 'bg-red-500' },
		approved: { text: 'Stunden freigegeben', dot: 'bg-emerald-500' },
		unapproved: { text: 'Freigabe zurückgenommen', dot: 'bg-amber-500' },
		rejected: { text: 'Stunden zurückgegeben', dot: 'bg-red-500' },
		team: { text: '', dot: 'bg-sky-500' }
	};

	let items = $state<ActivityItem[] | null>(null);
	let error = $state('');
	let more = $state(false);
	let loading = $state(false);
	const showActors = !!cloud();

	$effect(() => {
		listActivity(limit)
			.then((r) => ((items = r), (more = paged && r.length === limit), (error = '')))
			.catch((e) => ((items = []), (error = messageForUnknown(e))));
	});

	async function loadMore() {
		loading = true;
		try {
			const page = await listActivity(limit, items?.at(-1)?.at);
			items = [...(items ?? []), ...page.filter((p) => !items?.some((i) => i.id === p.id))];
			more = page.length === limit;
		} catch (e) {
			error = messageForUnknown(e);
		} finally {
			loading = false;
		}
	}

	const text = (i: ActivityItem) =>
		i.kind === 'team' ? describe({ action: i.action ?? '', actor_name: i.actor_name ?? '', subject_name: i.subject_name ?? null, data: i.data ?? {} }, projectName) : KIND[i.kind].text;

	const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
	const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
		['second', 60],
		['minute', 60],
		['hour', 24],
		['day', 7],
		['week', 4.35],
		['month', 12],
		['year', Infinity]
	];
	function ago(iso: string): string {
		let v = (Date.parse(iso) - Date.now()) / 1000;
		for (const [unit, size] of STEPS) {
			if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
			v /= size;
		}
		return '';
	}
	const month = (m: string) =>
		new Date(`${m}-01T00:00:00Z`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

	function subject(i: ActivityItem): string {
		if (i.month) return [i.subject_name, month(i.month)].filter(Boolean).join(' · ');
		return [i.invoice_number ?? 'Entwurf', i.customer_name].filter(Boolean).join(' · ');
	}
</script>

<section class="card space-y-4" data-testid="activity-feed">
	<h2 class="text-base font-semibold">Aktivität</h2>
	{#if items === null}
		<ul class="space-y-4" aria-hidden="true">
			{#each { length: 4 } as _, i (i)}
				<li class="flex items-center gap-3">
					<span class="skeleton h-2 w-2 rounded-full"></span>
					<span class="skeleton h-4 flex-1"></span>
					<span class="skeleton h-3 w-14"></span>
				</li>
			{/each}
		</ul>
	{:else if error}
		<p class="text-sm text-red-600 dark:text-red-400">{error}</p>
	{:else if items.length === 0}
		<EmptyState
			icon="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
			title="Noch keine Aktivität"
			hint="Neue Rechnungen, Zahlungen und Freigaben erscheinen hier."
		/>
	{:else}
		<ol class="relative">
			{#each items as i, n (i.id)}
				<li class="relative flex gap-3 pb-4 last:pb-0">
					{#if n < items.length - 1}
						<span class="absolute top-4 bottom-0 left-[3.5px] w-px bg-zinc-200 dark:bg-zinc-700/70" aria-hidden="true"></span>
					{/if}
					<span class="mt-1.5 h-2 w-2 shrink-0 rounded-full {KIND[i.kind].dot}"></span>
					<div class="min-w-0 flex-1">
						<p class="text-sm text-zinc-800 dark:text-zinc-100">
							{text(i)}
						</p>
						{#if i.kind !== 'team'}<p class="truncate text-xs text-zinc-500 dark:text-zinc-400">
							{#if i.invoice_id != null}
								<a href="/rechnungen/{i.invoice_id}" class="hover:text-accent-600 hover:underline dark:hover:text-accent-400">{subject(i)}</a>
							{:else}
								{subject(i)}
							{/if}
						</p>{/if}
					</div>
					<div class="flex shrink-0 items-center gap-2">
						{#if showActors && i.actor_name}
							<Avatar id={i.actor_id} name={i.actor_name} size="sm" />
						{/if}
						<time datetime={i.at} title={new Date(i.at).toLocaleString('de-DE')} class="text-xs tabular-nums text-zinc-400 dark:text-zinc-500">
							{ago(i.at)}
						</time>
					</div>
				</li>
			{/each}
		</ol>
		{#if more}
			<button class="btn-secondary" disabled={loading} onclick={loadMore}>Mehr</button>
		{/if}
	{/if}
</section>
