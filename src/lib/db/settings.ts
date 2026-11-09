import { invoke } from "@tauri-apps/api/core";
import { api, cloud, CloudError, resource } from "$lib/cloud";
import { getDb, safeFields } from "./connection";
import { createLogger } from "$lib/logger";
import { LEGAL_COUNTRIES } from "$lib/legal";
import type {
  InvoiceSettings,
  OrganizationSettings,
  S3Settings,
  VatTax,
} from "./types";

const log = createLogger("settings");

const VAT_TAX_COLUMNS = ["name", "description", "goods_value_percent"] as const;

type UpsertOrganizationSettings = Omit<
  OrganizationSettings,
  "id" | "created_at" | "updated_at"
>;
type UpsertInvoiceSettings = Omit<
  InvoiceSettings,
  "id" | "created_at" | "updated_at"
>;
export type UpsertS3Settings = Omit<
  S3Settings,
  "id" | "created_at" | "updated_at"
>;
type CreateVatTax = Omit<VatTax, "id" | "created_at" | "updated_at">;
type UpdateVatTax = Partial<CreateVatTax>;

const ORGANIZATION_DEFAULT: UpsertOrganizationSettings = {
  name: "",
  country: "",
  address: "",
  street: "",
  postal_code: "",
  city: "",
  email: "",
  phone_number: "",
  registering_id: "",
  bank_name: "",
  bank_iban: "",
  bank_account_holder: "",
  vatin: "",
  website: "",
  default_locale: "de",
  default_legal_country: "DE",
  einvoice_format: "plain",
  datev_consultant_number: "",
  datev_client_number: "",
  datev_skr: "03",
  datev_private_accounts: "",
};

const INVOICE_DEFAULT: UpsertInvoiceSettings = {
  currency: "EUR",
  decimal_places: 2,
  days_till_due: 14,
  due_surcharge: 0,
  notes: "",
  invoice_number_format: "RE-{YYYY}-{COUNT}",
  invoice_number_incrementor: 1,
  company_logo_data_url: null,
};

// Cloud: the organisation form spans companies (address, bank, tax ids) and
// company_settings (locale, e-invoice, DATEV); invoice settings are
// company_settings only. Desktop-only: `address` (legacy free-text fallback).
type RemoteCompany = Record<string, string | null>;
const SETTINGS_KEYS = [
  "default_locale",
  "default_legal_country",
  "einvoice_format",
  "datev_consultant_number",
  "datev_client_number",
  "datev_skr",
  "datev_private_accounts",
] as const;
const INVOICE_KEYS = Object.keys(
  INVOICE_DEFAULT,
) as (keyof UpsertInvoiceSettings)[];
const pick = <K extends string>(
  o: Record<string, unknown>,
  keys: readonly K[],
) => Object.fromEntries(keys.map((k) => [k, o[k]])) as Record<K, any>;
const remoteVat = resource<VatTax>("vat-taxes");

async function getRemoteOrganization(): Promise<UpsertOrganizationSettings> {
  const [c, s] = await Promise.all([
    api<RemoteCompany>("/api/company"),
    api<Record<string, unknown>>("/api/settings"),
  ]);
  const src: Record<string, unknown> = {
    ...c,
    country: c.country_code,
    vatin: c.vat_id,
    ...pick(s, SETTINGS_KEYS),
  };
  const org = { ...ORGANIZATION_DEFAULT };
  for (const k of Object.keys(org) as (keyof UpsertOrganizationSettings)[])
    if (src[k] != null) (org as any)[k] = src[k];
  return org;
}

// The desktop field is free text ("Deutschland"); the server keeps the ISO
// code the e-invoice uses as seller country. Unknown text: the legal country.
const countryCode = (country: string, fallback: string) => {
  const v = country.trim();
  if (/^[a-z]{2}$/i.test(v)) return v.toUpperCase();
  const hit = LEGAL_COUNTRIES.find(
    (c) => c.label.toLowerCase() === v.toLowerCase(),
  );
  return hit?.value ?? (fallback || "DE");
};

async function saveRemoteOrganization({
  address: _,
  country,
  vatin,
  default_locale,
  default_legal_country,
  einvoice_format,
  datev_consultant_number,
  datev_client_number,
  datev_skr,
  datev_private_accounts,
  ...company
}: UpsertOrganizationSettings): Promise<void> {
  await api("/api/company", "PATCH", {
    ...company,
    vat_id: vatin,
    ...(country // NOT NULL on the server
      ? { country_code: countryCode(country, default_legal_country) }
      : {}),
  });
  await api("/api/settings", "PATCH", {
    default_locale,
    default_legal_country,
    einvoice_format,
    datev_consultant_number,
    datev_client_number,
    datev_skr,
    datev_private_accounts,
  });
}

async function saveRemoteInvoice(data: UpsertInvoiceSettings): Promise<void> {
  try {
    await api("/api/settings", "PATCH", pick(data, INVOICE_KEYS));
  } catch (e) {
    if (e instanceof CloudError && e.code === "incrementor_decrease")
      throw new Error(
        "Die nächste Rechnungsnummer darf nicht kleiner werden (bereits vergeben)",
      );
    throw e;
  }
}

export async function getOrganizationSettings(): Promise<UpsertOrganizationSettings> {
  if (cloud()) return getRemoteOrganization();
  return readOrganizationSettings(await getDb());
}

/** Local organisation row; also used by the cloud import to copy it up. */
export async function readOrganizationSettings(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<UpsertOrganizationSettings> {
  const rows = await db.select<OrganizationSettings[]>(
    "SELECT * FROM settings_organization WHERE id = 1",
  );
  if (!rows[0]) return { ...ORGANIZATION_DEFAULT };
  const { id: _, created_at: __, updated_at: ___, ...data } = rows[0];
  for (const key in data) {
    if ((data as any)[key] == null) (data as any)[key] = "";
  }
  return data;
}

export async function saveOrganizationSettings(
  data: UpsertOrganizationSettings,
): Promise<void> {
  if (cloud()) return saveRemoteOrganization(data);
  const db = await getDb();
  await db.execute(
    `INSERT INTO settings_organization (id, name, country, address, street, postal_code, city, email, phone_number, registering_id, bank_name, bank_iban, bank_account_holder, vatin, website, default_locale, default_legal_country, einvoice_format, datev_consultant_number, datev_client_number, datev_skr, datev_private_accounts)
		 VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
		 ON CONFLICT(id) DO UPDATE SET
		 name = excluded.name,
		 country = excluded.country,
		 address = excluded.address,
		 street = excluded.street,
		 postal_code = excluded.postal_code,
		 city = excluded.city,
		 email = excluded.email,
		 phone_number = excluded.phone_number,
		 registering_id = excluded.registering_id,
		 bank_name = excluded.bank_name,
		 bank_iban = excluded.bank_iban,
		 bank_account_holder = excluded.bank_account_holder,
		 vatin = excluded.vatin,
		 website = excluded.website,
		 default_locale = excluded.default_locale,
		 default_legal_country = excluded.default_legal_country,
		 einvoice_format = excluded.einvoice_format,
		 datev_consultant_number = excluded.datev_consultant_number,
		 datev_client_number = excluded.datev_client_number,
		 datev_skr = excluded.datev_skr,
		 datev_private_accounts = excluded.datev_private_accounts,
		 updated_at = CURRENT_TIMESTAMP`,
    [
      data.name,
      data.country,
      data.address,
      data.street,
      data.postal_code,
      data.city,
      data.email,
      data.phone_number,
      data.registering_id,
      data.bank_name,
      data.bank_iban,
      data.bank_account_holder,
      data.vatin,
      data.website,
      data.default_locale,
      data.default_legal_country,
      data.einvoice_format,
      data.datev_consultant_number,
      data.datev_client_number,
      data.datev_skr,
      data.datev_private_accounts,
    ],
  );
}

export async function getInvoiceSettings(): Promise<UpsertInvoiceSettings> {
  if (cloud())
    return pick(
      await api<Record<string, unknown>>("/api/settings"),
      INVOICE_KEYS,
    );
  const db = await getDb();
  const rows = await db.select<InvoiceSettings[]>(
    "SELECT * FROM settings_invoice WHERE id = 1",
  );
  if (!rows[0]) return INVOICE_DEFAULT;
  const { id: _, created_at: __, updated_at: ___, ...data } = rows[0];
  return data;
}

export async function saveInvoiceSettings(
  data: UpsertInvoiceSettings,
): Promise<void> {
  if (cloud()) return saveRemoteInvoice(data);
  const db = await getDb();
  await db.execute(
    `INSERT INTO settings_invoice (id, currency, decimal_places, days_till_due, due_surcharge, notes, invoice_number_format, invoice_number_incrementor, company_logo_data_url)
		 VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT(id) DO UPDATE SET
		 currency = excluded.currency,
		 decimal_places = excluded.decimal_places,
		 days_till_due = excluded.days_till_due,
		 due_surcharge = excluded.due_surcharge,
		 notes = excluded.notes,
		 invoice_number_format = excluded.invoice_number_format,
		 invoice_number_incrementor = excluded.invoice_number_incrementor,
		 company_logo_data_url = excluded.company_logo_data_url,
		 updated_at = CURRENT_TIMESTAMP`,
    [
      data.currency,
      data.decimal_places,
      data.days_till_due,
      data.due_surcharge,
      data.notes,
      data.invoice_number_format,
      data.invoice_number_incrementor,
      data.company_logo_data_url,
    ],
  );
}

export async function listVatTaxes(): Promise<VatTax[]> {
  if (cloud()) return remoteVat.list();
  const db = await getDb();
  return db.select<VatTax[]>("SELECT * FROM vat_taxes ORDER BY name");
}

export async function createVatTax(data: CreateVatTax): Promise<number> {
  if (cloud()) return remoteVat.create(data);
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO vat_taxes (name, description, goods_value_percent) VALUES ($1, $2, $3)",
    [data.name, data.description, data.goods_value_percent],
  );
  return Number(result.lastInsertId ?? 0);
}

export async function updateVatTax(
  id: number,
  data: UpdateVatTax,
): Promise<void> {
  if (cloud()) return remoteVat.update(id, data);
  const fields = safeFields(data, VAT_TAX_COLUMNS);
  if (fields.length === 0) return;

  const sets = fields.map(([key], index) => `${key} = $${index + 1}`);
  sets.push("updated_at = CURRENT_TIMESTAMP");
  const values = fields.map(([, value]) => value);
  values.push(id);

  const db = await getDb();
  await db.execute(
    `UPDATE vat_taxes SET ${sets.join(", ")} WHERE id = $${values.length}`,
    values,
  );
}

export async function deleteVatTax(id: number): Promise<void> {
  if (cloud()) return remoteVat.remove(id);
  const db = await getDb();
  await db.execute("DELETE FROM vat_taxes WHERE id = $1", [id]);
}

const S3_DEFAULT: UpsertS3Settings = {
  enabled: 0,
  endpoint_url: "",
  region: "eu-central-1",
  bucket_name: "",
  access_key_id: "",
  secret_access_key: "",
  path_prefix: "rechnungen",
  auto_backup_enabled: 0,
  last_auto_backup_at: null,
  last_auto_backup_status: null,
  last_auto_backup_error: null,
};

/**
 * Reads S3 settings. Pass `withCredentials = false` when only flags/status
 * are needed: that skips the OS keychain read (and its log noise) entirely.
 */
export async function getS3Settings(
  withCredentials = true,
  db?: Awaited<ReturnType<typeof getDb>>, // getLocalDb() for the cloud receipt transfer
): Promise<UpsertS3Settings> {
  db ??= await getDb();
  const rows = await db.select<S3Settings[]>(
    "SELECT * FROM settings_s3 WHERE id = 1",
  );
  const base = rows[0]
    ? (() => {
        const { id: _, created_at: __, updated_at: ___, ...data } = rows[0];
        for (const key in S3_DEFAULT) {
          if ((data as any)[key] == null)
            (data as any)[key] = (S3_DEFAULT as any)[key];
        }
        return data;
      })()
    : { ...S3_DEFAULT };
  if (!withCredentials) return base;

  try {
    const creds = await invoke<{
      accessKeyId: string;
      secretAccessKey: string;
    }>("get_s3_credentials");
    base.access_key_id = creds.accessKeyId;
    base.secret_access_key = creds.secretAccessKey;
  } catch (e) {
    log.warn("Failed to read keyring credentials", e);
  }

  return base;
}

export async function saveS3Settings(data: UpsertS3Settings): Promise<void> {
  if (data.access_key_id || data.secret_access_key) {
    try {
      await invoke("store_s3_credentials", {
        accessKeyId: data.access_key_id,
        secretAccessKey: data.secret_access_key,
      });

      log.info("S3 credentials stored in keyring");
    } catch (e) {
      log.error("Failed to store S3 credentials in keyring", e);
      throw e;
    }
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO settings_s3 (id, enabled, endpoint_url, region, bucket_name, access_key_id, secret_access_key, path_prefix, auto_backup_enabled, last_auto_backup_at, last_auto_backup_status, last_auto_backup_error)
		 VALUES (1, $1, $2, $3, $4, '', '', $5, $6, $7, $8, $9)
		 ON CONFLICT(id) DO UPDATE SET
		 enabled = excluded.enabled,
		 endpoint_url = excluded.endpoint_url,
		 region = excluded.region,
		 bucket_name = excluded.bucket_name,
		 access_key_id = '',
		 secret_access_key = '',
		 path_prefix = excluded.path_prefix,
		 auto_backup_enabled = excluded.auto_backup_enabled,
		 last_auto_backup_at = excluded.last_auto_backup_at,
		 last_auto_backup_status = excluded.last_auto_backup_status,
		 last_auto_backup_error = excluded.last_auto_backup_error,
		 updated_at = CURRENT_TIMESTAMP`,
    [
      data.enabled,
      data.endpoint_url,
      data.region,
      data.bucket_name,
      data.path_prefix,
      data.auto_backup_enabled,
      data.last_auto_backup_at,
      data.last_auto_backup_status,
      data.last_auto_backup_error,
    ],
  );
}
