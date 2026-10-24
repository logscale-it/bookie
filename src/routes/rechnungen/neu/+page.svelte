<script lang="ts">
	import { goto } from '$app/navigation';
	import InvoiceForm, { type SaveData } from '../../../common/InvoiceForm.svelte';
	import { createInvoice, createInvoiceFromTimeEntries, updateInvoice, syncInvoiceItems } from '$lib/db/invoices';
	import { listCustomers } from '$lib/db/customers';
	import { listProjects } from '$lib/db/projects';
	import type { Customer, Project } from '$lib/db/types';
	import { withTransaction } from '$lib/db/connection';
	import { getInvoiceSettings, saveInvoiceSettings } from '$lib/db/settings';
	import { snapshotInvoice, createRecurring } from '$lib/db/recurring';
	import { advance } from '$lib/recurrence';
	import { t } from '$lib/i18n';
	import { cloud } from '$lib/cloud';

	let lastCreatedInvoiceId = $state<number | null>(null);
	let recurring = $state(false);

	// Cloud: draft from approved time entries (server picks and prices them).
	let customers = $state<Customer[]>([]);
	let projects = $state<Project[]>([]);
	let teCustomer = $state('');
	let teProject = $state('');
	let teFrom = $state('');
	let teTo = $state('');
	let teBusy = $state(false);
	let teError = $state('');
	const teProjects = $derived(projects.filter((p) => String(p.customer_id) === teCustomer));

	$effect(() => {
		if (!cloud()) return;
		// Cloud lists ignore the company id (the session's company is used).
		listCustomers(0).then((c) => (customers = c));
		listProjects(0).then((p) => (projects = p));
	});

	async function fromTimeEntries() {
		teBusy = true;
		teError = '';
		try {
			const id = await createInvoiceFromTimeEntries({
				customer_id: Number(teCustomer),
				project_id: teProject ? Number(teProject) : null,
				from: teFrom,
				to: teTo
			});
			await goto(`/rechnungen/${id}`);
		} catch (e) {
			teError =
				(e as { code?: string }).code === 'no_entries'
					? 'Keine freigegebenen, abrechenbaren und noch nicht abgerechneten Zeiteinträge im Zeitraum.'
					: String((e as Error).message ?? e);
		} finally {
			teBusy = false;
		}
	}

	async function handleSave(data: SaveData) {
		const items = data.items.map((item, i) => {
			const quantity = parseFloat(item.quantity) || 0;
			const unitPriceNet = parseFloat(item.unit_price_net) || 0;
			return {
				position: i + 1,
				description: item.description,
				quantity,
				unit: 'Stk',
				unit_price_net_cents: Math.round(unitPriceNet * 100),
				tax_rate: parseFloat(item.tax_rate) || 0,
				line_total_net_cents: Math.round(quantity * unitPriceNet * 100)
			};
		});
		const save = async () => {
			// DAT-1.d: convert float totals to integer cents at the DB boundary.
			const id = await createInvoice({
				company_id: data.company.id,
				customer_id: data.customerId,
				project_id: null,
				invoice_number: data.invoiceNumber,
				status: 'draft',
				issue_date: data.issueDate,
				due_date: data.dueDate || null,
				service_period_start: data.servicePeriodStart || null,
				service_period_end: data.servicePeriodEnd || null,
				buyer_reference: data.buyerReference || null,
				currency: data.currency,
				net_cents: Math.round(data.subtotal * 100),
				tax_cents: Math.round(data.taxTotal * 100),
				gross_cents: Math.round(data.grossTotal * 100),
				issuer_name: data.company.legal_name || data.company.name,
				issuer_tax_number: data.company.tax_number || null,
				issuer_vat_id: data.company.vat_id || null,
				issuer_bank_account_holder: data.company.bank_account_holder || null,
				issuer_bank_iban: data.company.bank_iban || null,
				issuer_bank_bic: data.company.bank_bic || null,
				issuer_bank_name: data.company.bank_name || null,
				issuer_street: data.company.street,
				issuer_postal_code: data.company.postal_code,
				issuer_city: data.company.city,
				issuer_country_code: data.company.country_code,
				recipient_name: data.customer?.name ?? '',
				recipient_street: data.customer?.street ?? null,
				recipient_postal_code: data.customer?.postal_code ?? null,
				recipient_city: data.customer?.city ?? null,
				recipient_country_code: data.customer?.country_code ?? null,
				notes: data.notes || null,
				s3_key: null,
				language: data.language || 'de',
				legal_country_code: data.legalCountry || 'DE',
				delivery_date: data.issueDate,
				due_surcharge: data.dueSurcharge
			});

			await syncInvoiceItems(id, items);
			return id;
		};
		// Cloud: a draft (POST) plus its items (PATCH); the server keeps totals,
		// assigns the number on issue and bumps the incrementor itself.
		// ponytail: two requests, a failed item save leaves an empty (deletable) draft.
		const invoiceId = cloud() ? await save() : await withTransaction(save);

		if (!cloud()) {
			const settings = await getInvoiceSettings();
			await saveInvoiceSettings({
				...settings,
				invoice_number_incrementor: settings.invoice_number_incrementor + 1
			});
		}

		// Recurring: snapshot this invoice and schedule the next copy one month
		// out on the same day. The boot generator (see +layout) materialises it.
		if (recurring) {
			const snap = await snapshotInvoice(invoiceId);
			await createRecurring({
				company_id: data.company.id,
				kind: 'invoice',
				label: snap.label,
				frequency: 'monthly',
				interval_count: 1,
				next_run_date: advance(data.issueDate, 'monthly', 1),
				end_date: null,
				payload: snap.payload
			});
		}

		lastCreatedInvoiceId = invoiceId;
		await goto('/rechnungen');
	}
</script>

<section class="space-y-6">
	<header class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">{t('invoices.newTitle')}</h1>
			<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('invoices.newSubtitle')}</p>
		</div>
		<a
			href="/rechnungen"
			class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-700"
		>
			{t('common.back')}
		</a>
	</header>

	{#if cloud()}
		<details class="card space-y-3">
			<summary class="cursor-pointer text-sm font-medium">Rechnung aus Zeiteinträgen</summary>
			<p class="text-xs text-zinc-500 dark:text-zinc-400">
				Übernommen werden nur freigegebene, abrechenbare Zeiteinträge, die noch auf keiner Rechnung stehen
				— eine Position pro Eintrag zum Stundensatz des Projekts (19 % USt). Es entsteht ein Entwurf, den du vor dem Ausstellen prüfen kannst.
			</p>
			<div class="grid gap-3 md:grid-cols-4">
				<label class="text-sm">
					<span class="label">Kunde</span>
					<select bind:value={teCustomer} onchange={() => (teProject = '')} class="input-base">
						<option value="">Kunde wählen</option>
						{#each customers as c (c.id)}<option value={String(c.id)}>{c.name}</option>{/each}
					</select>
				</label>
				<label class="text-sm">
					<span class="label">Projekt</span>
					<select bind:value={teProject} class="input-base" disabled={!teCustomer}>
						<option value="">Alle Projekte</option>
						{#each teProjects as p (p.id)}<option value={String(p.id)}>{p.name}</option>{/each}
					</select>
				</label>
				<label class="text-sm">
					<span class="label">Von</span>
					<input type="date" bind:value={teFrom} class="input-base" />
				</label>
				<label class="text-sm">
					<span class="label">Bis</span>
					<input type="date" bind:value={teTo} class="input-base" />
				</label>
			</div>
			{#if teError}<p class="text-sm text-red-600 dark:text-red-400">{teError}</p>{/if}
			<div class="flex justify-end">
				<button type="button" class="btn-primary" onclick={fromTimeEntries} disabled={teBusy || !teCustomer}>
					{teBusy ? 'Erstelle…' : 'Entwurf erstellen'}
				</button>
			</div>
		</details>
	{/if}

	<label class="flex w-fit items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
		<input type="checkbox" bind:checked={recurring} class="h-4 w-4 rounded border-zinc-300" />
		{t('common.recurringMonthly')}
	</label>

	<InvoiceForm
		mode="create"
		onSave={handleSave}
		onS3KeyUpdate={(key) => {
			if (lastCreatedInvoiceId) {
				updateInvoice(lastCreatedInvoiceId, { s3_key: key });
			}
		}}
	/>
</section>
