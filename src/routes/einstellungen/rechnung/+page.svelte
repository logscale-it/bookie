<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import FileUpload from '../../../common/FileUpload.svelte';
	import { getInvoiceSettings, saveInvoiceSettings } from '$lib/db/settings';
	import { t } from '$lib/i18n';
	import { toasts } from '$lib/ui/toasts.svelte';
	import SectionHead from '../SectionHead.svelte';
	import SaveBar from '../SaveBar.svelte';
	import FormSkeleton from '../FormSkeleton.svelte';

	let form = $state({
		currency: 'EUR',
		decimal_places: 2,
		days_till_due: 14,
		due_surcharge: 0,
		notes: '',
		invoice_number_format: 'RE-{YYYY}-{COUNT}',
		invoice_number_incrementor: 1,
		company_logo_data_url: null as string | null
	});
	let decimalPlaces = $state('2');
	let daysTillDue = $state('14');
	let dueSurcharge = $state('0');
	let incrementor = $state('1');
	let logoFiles = $state<FileList | null>(null);
	let loading = $state(true);
	let saving = $state(false);

	onMount(async () => {
		form = await getInvoiceSettings();
		decimalPlaces = String(form.decimal_places);
		daysTillDue = String(form.days_till_due);
		dueSurcharge = String(form.due_surcharge);
		incrementor = String(form.invoice_number_incrementor);
		loading = false;
	});

	async function fileToDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
	}

	async function handleSave() {
		saving = true;
		if (logoFiles?.[0]) {
			form.company_logo_data_url = await fileToDataUrl(logoFiles[0]);
		}
		form.decimal_places = Number(decimalPlaces) || 0;
		form.days_till_due = Number(daysTillDue) || 0;
		form.due_surcharge = Number(dueSurcharge) || 0;
		form.invoice_number_incrementor = Math.max(1, Number(incrementor) || 1);
		try {
			await saveInvoiceSettings(form);
			toasts.success(t('settings.invoiceSaved'));
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : String(err));
		} finally {
			saving = false;
		}
	}
</script>

{#if loading}
	<section class="card p-5"><FormSkeleton fields={6} /></section>
{:else}
	<div class="space-y-6">
		<section class="card space-y-4 p-5">
			<SectionHead eyebrow="Beträge & Fristen" title={t('settings.invoiceTitle')} desc="Währung, Rundung und Zahlungsziel für neue Rechnungen." />
			<div class="grid gap-3 md:grid-cols-2">
				<TextInput bind:value={form.currency} label={t('settings.currencyLabel')} />
				<TextInput bind:value={decimalPlaces} label={t('settings.decimalPlaces')} type="number" />
				<TextInput bind:value={daysTillDue} label={t('settings.daysTillDue')} type="number" />
				<TextInput bind:value={dueSurcharge} label={t('settings.surcharge')} type="number" />
				<div class="md:col-span-2"><TextInput bind:value={form.notes} label={t('common.notes')} /></div>
			</div>
		</section>

		<section class="card space-y-4 p-5">
			<SectionHead eyebrow="Nummernkreis" title={t('settings.invoiceNumberFormat')} desc="Platzhalter: {'{YYYY}'} = Jahr, {'{COUNT}'} = fortlaufende Nummer. Rechnungsnummern müssen lückenlos und eindeutig sein." />
			<div class="grid gap-3 md:grid-cols-2">
				<TextInput bind:value={form.invoice_number_format} label={t('settings.invoiceNumberFormat')} />
				<TextInput bind:value={incrementor} label={t('settings.invoiceNumberIncrement')} type="number" />
			</div>
		</section>

		<section class="card space-y-4 p-5">
			<SectionHead eyebrow="Branding" title={t('settings.companyLogo')} desc="Wird oben auf jeder Rechnung gedruckt." />
			<div class="flex flex-col gap-4 sm:flex-row sm:items-start">
				{#if form.company_logo_data_url}
					<img src={form.company_logo_data_url} alt={t('settings.companyLogo')} class="h-[88px] w-auto max-w-[200px] rounded-xl bg-white object-contain p-2 ring-1 ring-zinc-900/10 dark:ring-white/10" />
				{/if}
				<div class="flex-1"><FileUpload bind:files={logoFiles} label={t('settings.uploadLogo')} accept="image/*" /></div>
			</div>
		</section>

		<SaveBar {saving} onsave={handleSave} />
	</div>
{/if}
