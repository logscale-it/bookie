<script lang="ts">
	// Global command palette (⌘K / Ctrl+K). Mounted once in the root layout.
	// Fuzzy-free substring search across navigation targets, quick actions,
	// and live data (invoices + customers/suppliers). Fully keyboard-driven:
	// ↑/↓ to move, ↵ to run, esc to close.
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { t } from '$lib/i18n';
	import { commandPalette } from '$lib/ui/command.svelte';
	import { listCompanies } from '$lib/db/companies';
	import { listCustomers } from '$lib/db/customers';
	import { listAllInvoices, type InvoiceWithCustomer } from '$lib/db/invoices';
	import type { Customer } from '$lib/db/types';

	interface Command {
		id: string;
		label: string;
		sublabel?: string;
		group: string;
		keywords: string;
		icon: string;
		run: () => void;
	}

	const ICONS = {
		home: 'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
		invoice: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
		inbox: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4',
		project: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
		building: 'M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21',
		clock: 'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
		cog: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z',
		plus: 'M12 4.5v15m7.5-7.5h-15',
		user: 'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z'
	};

	let query = $state('');
	let selected = $state(0);
	let loaded = $state(false);
	let customers = $state<Customer[]>([]);
	let invoices = $state<InvoiceWithCustomer[]>([]);
	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);

	function close(): void {
		commandPalette.open = false;
	}

	function navTo(href: string): void {
		close();
		goto(href);
	}

	async function ensureData(): Promise<void> {
		if (loaded) return;
		loaded = true;
		try {
			const companies = await listCompanies();
			const companyId = companies[0]?.id;
			if (companyId === undefined) return;
			const [cs, inv] = await Promise.all([
				listCustomers(companyId),
				listAllInvoices({ limit: 500 })
			]);
			customers = cs;
			invoices = inv.rows;
		} catch {
			// Data unavailable (e.g. DB not ready) — the palette still works for
			// navigation and quick actions.
		}
	}

	async function openPalette(): Promise<void> {
		commandPalette.open = true;
		query = '';
		selected = 0;
		await ensureData();
		await tick();
		inputEl?.focus();
	}

	function handleGlobalKey(e: KeyboardEvent): void {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			if (commandPalette.open) close();
			else openPalette();
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleGlobalKey);
		return () => window.removeEventListener('keydown', handleGlobalKey);
	});

	// React to external opens (e.g. the sidebar search button toggling the
	// shared state) so data is loaded and the input gets focus.
	let wasOpen = false;
	$effect(() => {
		if (commandPalette.open && !wasOpen) {
			query = '';
			selected = 0;
			ensureData().then(() => tick().then(() => inputEl?.focus()));
		}
		wasOpen = commandPalette.open;
	});

	const staticCommands = $derived<Command[]>([
		{ id: 'nav-overview', label: t('nav.overview'), group: t('command.pages'), keywords: 'übersicht overview dashboard start', icon: ICONS.home, run: () => navTo('/uebersicht') },
		{ id: 'nav-invoices', label: t('nav.invoices'), group: t('command.pages'), keywords: 'rechnungen invoices', icon: ICONS.invoice, run: () => navTo('/rechnungen') },
		{ id: 'nav-incoming', label: t('nav.incomingInvoices'), group: t('command.pages'), keywords: 'eingehende rechnungen incoming bills lieferant', icon: ICONS.inbox, run: () => navTo('/eingehende-rechnungen') },
		{ id: 'nav-projects', label: t('nav.projects'), group: t('command.pages'), keywords: 'projekte projects', icon: ICONS.project, run: () => navTo('/projekte') },
		{ id: 'nav-companies', label: t('nav.companies'), group: t('command.pages'), keywords: 'unternehmen companies kunden lieferanten customers', icon: ICONS.building, run: () => navTo('/unternehmen') },
		{ id: 'nav-time', label: t('nav.timeTracking'), group: t('command.pages'), keywords: 'zeiterfassung time tracking stunden', icon: ICONS.clock, run: () => navTo('/zeiterfassung') },
		{ id: 'nav-settings', label: t('nav.settings'), group: t('command.pages'), keywords: 'einstellungen settings konfiguration', icon: ICONS.cog, run: () => navTo('/einstellungen') },
		{ id: 'act-new-invoice', label: t('command.newInvoice'), group: t('command.actions'), keywords: 'neue rechnung new invoice erstellen create', icon: ICONS.plus, run: () => navTo('/rechnungen/neu') },
		{ id: 'act-new-company', label: t('command.newCustomer'), group: t('command.actions'), keywords: 'neues unternehmen kunde lieferant new customer company anlegen', icon: ICONS.plus, run: () => navTo('/unternehmen') },
		{ id: 'act-time', label: t('command.newTimeEntry'), group: t('command.actions'), keywords: 'zeit erfassen time entry stunden', icon: ICONS.plus, run: () => navTo('/zeiterfassung') }
	]);

	const dynamicCommands = $derived<Command[]>([
		...invoices.map((i) => ({
			id: `inv-${i.id}`,
			label: i.invoice_number,
			sublabel: i.customer_name ?? undefined,
			group: t('command.invoices'),
			keywords: `${i.invoice_number} ${i.customer_name ?? ''}`,
			icon: ICONS.invoice,
			run: () => navTo(`/rechnungen/${i.id}`)
		})),
		...customers.map((c) => ({
			id: `cus-${c.id}`,
			label: c.name,
			sublabel: [c.city, c.email].filter(Boolean).join(' · ') || undefined,
			group: t('command.customers'),
			keywords: `${c.name} ${c.email ?? ''} ${c.city ?? ''} ${c.vat_id ?? ''}`,
			icon: ICONS.user,
			run: () => navTo('/unternehmen')
		}))
	]);

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const all = [...staticCommands, ...dynamicCommands];
		if (!q) return all.slice(0, 30);
		const terms = q.split(/\s+/);
		return all
			.filter((c) => {
				const hay = `${c.label} ${c.sublabel ?? ''} ${c.keywords}`.toLowerCase();
				return terms.every((term) => hay.includes(term));
			})
			.slice(0, 30);
	});

	const groups = $derived.by(() => {
		const map = new Map<string, Command[]>();
		for (const c of filtered) {
			const bucket = map.get(c.group);
			if (bucket) bucket.push(c);
			else map.set(c.group, [c]);
		}
		return [...map.entries()];
	});

	$effect(() => {
		if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
	});

	async function moveSelection(delta: number): Promise<void> {
		if (filtered.length === 0) return;
		selected = (selected + delta + filtered.length) % filtered.length;
		await tick();
		listEl?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	function onInputKey(e: KeyboardEvent): void {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			moveSelection(1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			moveSelection(-1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			filtered[selected]?.run();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}
</script>

{#if commandPalette.open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
		onclick={close}
		role="presentation"
	>
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div
			class="w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-800"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-label={t('command.placeholder')}
			tabindex="-1"
		>
			<div class="flex items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-700">
				<svg class="h-4 w-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					bind:this={inputEl}
					bind:value={query}
					onkeydown={onInputKey}
					placeholder={t('command.placeholder')}
					class="w-full bg-transparent py-3.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
					autocomplete="off"
					spellcheck="false"
				/>
				<kbd class="hidden shrink-0 rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 sm:block dark:border-zinc-600">ESC</kbd>
			</div>

			<div bind:this={listEl} class="max-h-[52vh] overflow-y-auto p-2">
				{#if filtered.length === 0}
					<div class="px-3 py-8 text-center text-sm text-zinc-400">{t('command.empty')}</div>
				{:else}
					{#each groups as [groupName, items] (groupName)}
						<div class="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{groupName}</div>
						{#each items as cmd (cmd.id)}
							{@const idx = filtered.indexOf(cmd)}
							<button
								type="button"
								data-idx={idx}
								onclick={cmd.run}
								onmousemove={() => (selected = idx)}
								class="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition {idx === selected ? 'bg-blue-600 text-white' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700/50'}"
							>
								<svg class="h-4 w-4 shrink-0 {idx === selected ? 'text-white' : 'text-zinc-400'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d={cmd.icon} /></svg>
								<span class="min-w-0 flex-1 truncate font-medium">{cmd.label}</span>
								{#if cmd.sublabel}
									<span class="ml-2 shrink-0 truncate text-xs {idx === selected ? 'text-blue-100' : 'text-zinc-400'}">{cmd.sublabel}</span>
								{/if}
							</button>
						{/each}
					{/each}
				{/if}
			</div>

			<div class="flex items-center gap-4 border-t border-zinc-200 px-4 py-2 text-[11px] text-zinc-400 dark:border-zinc-700">
				<span class="flex items-center gap-1"><kbd class="rounded border border-zinc-200 px-1 dark:border-zinc-600">↑↓</kbd> {t('command.navigate')}</span>
				<span class="flex items-center gap-1"><kbd class="rounded border border-zinc-200 px-1 dark:border-zinc-600">↵</kbd> {t('command.select')}</span>
				<span class="flex items-center gap-1"><kbd class="rounded border border-zinc-200 px-1 dark:border-zinc-600">esc</kbd> {t('command.close')}</span>
			</div>
		</div>
	</div>
{/if}
