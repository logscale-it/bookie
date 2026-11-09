<script lang="ts">
	// OPS-1.b: Full-window blocking diagnostics view, rendered by the root
	// layout when `boot_check` reports a failed blocking probe (per-issue:
	// "render a full-window diagnostics view with per-check status and
	// 'wie behebe ich das' links. App nav is not reachable until all
	// blocking checks pass").
	//
	// Only `kind === "Failed"` counts as a failure (see `isFailure` in ./boot.ts).
	import {
		ALL_SLOTS,
		isFailure,
		type BootStatus,
		type Slot,
	} from "./boot";
	import { t, tp } from "$lib/i18n";

	let { status, onRetry }: { status: BootStatus; onRetry?: () => void } = $props();

	// Per-slot fix-it copy (i18n bootDiagnostics.*). Keyed by `BookieError.kind`
	// first, then by slot name as a fallback for unrecognised error kinds.
	const slotTitle = (slot: Slot) => t(`bootDiagnostics.slots.${slot}`);
	const FIX_IT_KINDS = ['IoError', 'KeyringUnavailable', 'MigrationOutOfDate'];

	function renderStatus(slot: Slot): string {
		const r = status[slot];
		switch (r.kind) {
			case "Ok":
				return "OK";
			case "Skipped":
				return t('bootDiagnostics.skipped');
			case "Failed":
				return r.error.kind ? tp('bootDiagnostics.failedKind', { kind: r.error.kind }) : t('bootDiagnostics.failed');
		}
	}

	function fixIt(slot: Slot): string {
		const r = status[slot];
		if (r.kind !== "Failed") return "";
		return FIX_IT_KINDS.includes(r.error.kind) ? t(`bootDiagnostics.fixByKind.${r.error.kind}`) : t(`bootDiagnostics.fixBySlot.${slot}`);
	}

	function pillClass(slot: Slot): string {
		const r = status[slot];
		if (r.kind === "Ok")
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
		if (r.kind === "Failed")
			return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
		// Skipped renders as informational, not as a failure.
		return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
	}
</script>

<!--
  Full-window overlay. The root layout mounts this as the SOLE child when
  `hasBlockingFailure(status)` is true, so app navigation is not reachable
  until the user fixes the underlying issue and retries.
-->
<div
	class="flex h-screen w-screen items-center justify-center overflow-y-auto bg-zinc-100 bg-[radial-gradient(ellipse_at_top,rgb(255_255_255/0.9),transparent_60%)] p-6 dark:bg-[radial-gradient(ellipse_at_top,rgb(255_255_255/0.04),transparent_60%)] text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
	role="alert"
	aria-live="assertive"
	data-testid="boot-diagnostics"
>
	<div class="bezel w-full max-w-2xl animate-pop">
	<div class="bezel-core p-6">
		<div class="mb-4 flex items-center gap-3">
			<img src="/bookie.svg" alt="Bookie" class="h-10 w-10 rounded-xl shadow-soft" />
			<div>
				<h1 class="page-header">{t('bootDiagnostics.title')}</h1>
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					{t('bootDiagnostics.intro')}
				</p>
			</div>
		</div>

		<ul class="flex flex-col gap-3">
			{#each ALL_SLOTS as slot}
				{@const result = status[slot]}
				<li
					class="rounded-xl bg-zinc-50/60 p-3 ring-1 ring-zinc-900/5 dark:bg-zinc-900/30 dark:ring-white/10"
					data-slot={slot}
					data-status={result.kind}
				>
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-medium">{slotTitle(slot)}</span>
						<span
							class={`rounded-full px-2 py-0.5 text-xs font-medium ${pillClass(slot)}`}
						>
							{renderStatus(slot)}
						</span>
					</div>
					{#if isFailure(result)}
						<p
							class="mt-2 text-xs text-zinc-600 dark:text-zinc-400"
							data-testid="fix-it"
						>
							{fixIt(slot)}
						</p>
						<a
							href={`https://github.com/logscale-it/bookie/blob/master/docs/diagnostics.md#${slot}`}
							target="_blank"
							rel="noopener noreferrer"
							class="mt-1 inline-block text-xs text-accent-600 hover:underline dark:text-accent-400"
						>
							{t('bootDiagnostics.howToFix')}
						</a>
					{/if}
				</li>
			{/each}
		</ul>

		{#if onRetry}
			<div class="mt-4 flex justify-end">
				<button
					type="button"
					class="btn-primary"
					onclick={onRetry}
					data-testid="boot-retry"
				>
					{t('bootDiagnostics.retry')}
				</button>
			</div>
		{/if}
	</div>
	</div>
</div>
