<script lang="ts">
	// OPS-1.b: Full-window blocking diagnostics view, rendered by the root
	// layout when `boot_check` reports a failed blocking probe (per-issue:
	// "render a full-window diagnostics view with per-check status and
	// 'wie behebe ich das' links. App nav is not reachable until all
	// blocking checks pass").
	//
	// The schema slot is `delegated` to `schema_version_check` (OBS-3.a) and
	// the s3 slot is `skipped` when the user has not configured S3, so this
	// view treats only `status === "err"` as a failure (see `isFailure` in
	// ./boot.ts).
	import {
		ALL_SLOTS,
		isFailure,
		type BootStatus,
		type Slot,
	} from "./boot";

	let { status, onRetry }: { status: BootStatus; onRetry?: () => void } = $props();

	const SLOT_TITLES: Record<Slot, string> = {
		app_data_dir: "Anwendungsdaten-Verzeichnis",
		keyring: "Schlüsselbund (OS Keyring)",
		s3: "S3-Speicher",
		schema: "Datenbank-Schema",
	};

	// Per-slot fix-it copy. Keyed by `BookieError.kind` first, then by slot
	// name as a fallback for unrecognised error kinds. UI copy is German per
	// project convention (`UI labels in German`).
	const FIX_IT_BY_KIND: Record<string, string> = {
		IoError:
			"Stellen Sie sicher, dass das Anwendungsdaten-Verzeichnis existiert und beschreibbar ist (Schreibrechte, freier Speicher, kein Read-only Mount).",
		KeyringUnavailable:
			"Der OS-Schlüsselbund ist nicht erreichbar. Unter Linux benötigen Sie einen laufenden Secret Service (z.B. gnome-keyring oder KWallet).",
		MigrationOutOfDate:
			"Die Datenbank ist auf einem älteren Schema-Stand. Bitte starten Sie die App neu, damit Migrationen ausgeführt werden.",
		S3CredsInvalid:
			"Die S3-Zugangsdaten sind ungültig. Prüfen Sie Access Key und Secret Key in den Einstellungen.",
		S3Unreachable:
			"Der S3-Endpunkt ist nicht erreichbar. Prüfen Sie Endpoint-URL und Netzwerkverbindung.",
		S3BucketMissing:
			"Der angegebene S3-Bucket existiert nicht. Prüfen Sie den Bucket-Namen in den Einstellungen.",
		S3EndpointInvalid:
			"Die S3-Endpoint-URL ist ungültig. Sie muss mit https:// beginnen (oder http:// auf localhost).",
	};

	const FIX_IT_BY_SLOT: Record<Slot, string> = {
		app_data_dir:
			"Stellen Sie sicher, dass das Anwendungsdaten-Verzeichnis existiert und beschreibbar ist.",
		keyring:
			"Der OS-Schlüsselbund konnte nicht erreicht werden. Bitte aktivieren Sie einen Secret-Service-Dienst.",
		s3: "Prüfen Sie die S3-Einstellungen und die Netzwerkverbindung.",
		schema:
			"Bitte starten Sie die App neu, damit Migrationen erneut ausgeführt werden.",
	};

	function renderStatus(slot: Slot): string {
		const r = status[slot];
		switch (r.status) {
			case "ok":
				return "OK";
			case "skipped":
				return "Übersprungen";
			case "delegated":
				return "Wird separat geprüft";
			case "err":
				return `Fehler${r.error.kind ? ` (${r.error.kind})` : ""}`;
		}
	}

	function fixIt(slot: Slot): string {
		const r = status[slot];
		if (r.status !== "err") return "";
		return FIX_IT_BY_KIND[r.error.kind] ?? FIX_IT_BY_SLOT[slot];
	}

	function pillClass(slot: Slot): string {
		const r = status[slot];
		if (r.status === "ok")
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
		if (r.status === "err")
			return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
		// skipped + delegated render as informational, not as a failure.
		return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
	}
</script>

<!--
  Full-window overlay. The root layout mounts this as the SOLE child when
  `hasBlockingFailure(status)` is true, so app navigation is not reachable
  until the user fixes the underlying issue and retries.
-->
<div
	class="flex h-screen w-screen items-center justify-center overflow-y-auto bg-zinc-100 p-6 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
	role="alert"
	aria-live="assertive"
	data-testid="boot-diagnostics"
>
	<div class="card w-full max-w-2xl">
		<div class="mb-4 flex items-center gap-3">
			<img src="/bookie.svg" alt="Bookie" class="h-8 w-8 rounded-lg" />
			<div>
				<h1 class="page-header">Bookie kann nicht starten</h1>
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					Mindestens eine Startprüfung ist fehlgeschlagen. Beheben Sie die
					unten aufgeführten Probleme und klicken Sie auf „Erneut prüfen".
				</p>
			</div>
		</div>

		<ul class="flex flex-col gap-3">
			{#each ALL_SLOTS as slot}
				{@const result = status[slot]}
				<li
					class="rounded-md border border-zinc-200 p-3 dark:border-zinc-700"
					data-slot={slot}
					data-status={result.status}
				>
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-medium">{SLOT_TITLES[slot]}</span>
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
							class="mt-1 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
						>
							Wie behebe ich das?
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
					Erneut prüfen
				</button>
			</div>
		{/if}
	</div>
</div>
