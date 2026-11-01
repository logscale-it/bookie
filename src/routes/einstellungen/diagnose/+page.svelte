<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import SectionHead from '../SectionHead.svelte';
	import EmptyState from '../../../common/EmptyState.svelte';

	/**
	 * One log line as parsed from the on-disk JSON-line file. The Rust
	 * `tracing-subscriber` JSON layer produces objects shaped roughly like
	 * `{ timestamp, level, target, fields: { message, ... }, span?, spans? }`.
	 * The shape is loosely typed because tracing may add or omit keys
	 * depending on configured layers, and the Diagnose UI treats unknown
	 * fields as opaque.
	 */
	interface ParsedLine {
		raw: string;
		timestamp?: string;
		level?: string;
		target?: string;
		message?: string;
		fields?: Record<string, unknown>;
	}

	let lines = $state<ParsedLine[]>([]);
	let loading = $state(false);
	let errorMsg = $state('');

	function parseLine(raw: string): ParsedLine {
		try {
			const obj = JSON.parse(raw) as Record<string, unknown>;
			const fields = (obj.fields ?? {}) as Record<string, unknown>;
			return {
				raw,
				timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
				level: typeof obj.level === 'string' ? obj.level : undefined,
				target: typeof obj.target === 'string' ? obj.target : undefined,
				message: typeof fields.message === 'string' ? fields.message : undefined,
				fields
			};
		} catch {
			return { raw };
		}
	}

	function severityClasses(level: string | undefined): string {
		switch ((level ?? '').toUpperCase()) {
			case 'ERROR':
				return 'border-red-500 bg-red-50/70 text-red-900 dark:bg-red-950/40 dark:text-red-200';
			case 'WARN':
				return 'border-amber-500 bg-amber-50/70 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200';
			case 'INFO':
				return 'border-accent-500 text-zinc-800 dark:text-zinc-200';
			default:
				return 'border-zinc-300 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400';
		}
	}

	async function refresh(): Promise<void> {
		loading = true;
		errorMsg = '';
		try {
			const raw = await invoke<string[]>('read_log_tail', { maxLines: 200 });
			lines = raw.map(parseLine);
		} catch (e) {
			errorMsg = `${t('settings.diagnoseError')}: ${e}`;
			lines = [];
		}
		loading = false;
	}

	onMount(() => {
		void refresh();
	});
</script>

<section class="card space-y-4 p-5">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<SectionHead eyebrow="Support" title={t('settings.diagnoseTitle')} desc={t('settings.diagnoseDesc')} />
		<button type="button" onclick={refresh} disabled={loading} class="btn-secondary">
			<svg class="h-4 w-4 {loading ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
			{loading ? t('settings.diagnoseLoading') : t('settings.diagnoseRefresh')}
		</button>
	</div>

	{#if errorMsg}
		<p class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-600/10 dark:bg-red-950/40 dark:text-red-300">{errorMsg}</p>
	{/if}

	{#if loading && lines.length === 0}
		<div class="space-y-2 rounded-xl p-3 ring-1 ring-zinc-900/5 dark:ring-white/10" aria-busy="true">
			{#each Array(6) as _, i}<div class="skeleton h-3 {i % 2 ? 'w-2/3' : 'w-5/6'}"></div>{/each}
		</div>
	{:else if lines.length === 0 && !errorMsg}
		<EmptyState icon="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" title={t('settings.diagnoseEmpty')} />
	{/if}

	{#if lines.length > 0}
		<ul class="max-h-[600px] space-y-0.5 overflow-y-auto rounded-xl bg-zinc-50 p-2 font-mono text-xs ring-1 ring-zinc-900/5 dark:bg-zinc-900/60 dark:ring-white/10">
			{#each lines as line, idx (idx)}
				<li class="rounded-r-md border-l-2 px-2.5 py-1 {severityClasses(line.level)}">
					<div class="flex flex-wrap items-baseline gap-2">
						<span class="font-semibold">{(line.level ?? '?').toUpperCase()}</span>
						{#if line.timestamp}
							<span class="text-[10px] tabular-nums opacity-60">{line.timestamp}</span>
						{/if}
						{#if line.target}
							<span class="text-[10px] opacity-60">[{line.target}]</span>
						{/if}
					</div>
					<div class="mt-0.5 break-words">
						{line.message ?? line.raw}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
