<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';

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
				return 'border-l-4 border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200';
			case 'WARN':
				return 'border-l-4 border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200';
			case 'INFO':
				return 'border-l-4 border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-200';
			case 'DEBUG':
			case 'TRACE':
				return 'border-l-4 border-zinc-400 bg-zinc-50 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300';
			default:
				return 'border-l-4 border-zinc-300 bg-white text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200';
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

<section class="card space-y-4">
	<div class="flex items-start justify-between gap-4">
		<div>
			<h2 class="text-base font-semibold">{t('settings.diagnoseTitle')}</h2>
			<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t('settings.diagnoseDesc')}</p>
		</div>
		<button type="button" onclick={refresh} disabled={loading} class="btn-secondary">
			{loading ? t('settings.diagnoseLoading') : t('settings.diagnoseRefresh')}
		</button>
	</div>

	{#if errorMsg}
		<p class="text-xs text-red-600">{errorMsg}</p>
	{/if}

	{#if !loading && lines.length === 0 && !errorMsg}
		<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('settings.diagnoseEmpty')}</p>
	{/if}

	{#if lines.length > 0}
		<ul class="max-h-[600px] space-y-1 overflow-y-auto rounded-md border border-zinc-200 p-2 font-mono text-xs dark:border-zinc-700">
			{#each lines as line, idx (idx)}
				<li class={`rounded px-2 py-1 ${severityClasses(line.level)}`}>
					<div class="flex flex-wrap items-baseline gap-2">
						<span class="font-semibold">{(line.level ?? '?').toUpperCase()}</span>
						{#if line.timestamp}
							<span class="text-[10px] opacity-70">{line.timestamp}</span>
						{/if}
						{#if line.target}
							<span class="text-[10px] opacity-70">[{line.target}]</span>
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
