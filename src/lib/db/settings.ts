import { invoke } from "@tauri-apps/api/core";
import { getDb, safeFields } from "./connection";
import { createLogger } from "$lib/logger";
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

export async function getOrganizationSettings(): Promise<UpsertOrganizationSettings> {
  const db = await getDb();
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
  const db = await getDb();
  await db.execute(
    `INSERT INTO settings_organization (id, name, country, address, street, postal_code, city, email, phone_number, registering_id, bank_name, bank_iban, bank_account_holder, vatin, website, default_locale, default_legal_country)
		 VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
    ],
  );
}

export async function getInvoiceSettings(): Promise<UpsertInvoiceSettings> {
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
  const db = await getDb();
  return db.select<VatTax[]>("SELECT * FROM vat_taxes ORDER BY name");
}

export async function createVatTax(data: CreateVatTax): Promise<number> {
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

export async function getS3Settings(): Promise<UpsertS3Settings> {
  const db = await getDb();
  const rows = await db.select<S3Settings[]>(
    "SELECT * FROM settings_s3 WHERE id = 1",
  );
  const base = rows[0]
    ? (() => {
        const { id: _, created_at: __, updated_at: ___, ...data } = rows[0];
        for (const key in S3_DEFAULT) {
          if ((data as any)[key] == null) (data as any)[key] = (S3_DEFAULT as any)[key];
        }
        return data;
      })()
    : { ...S3_DEFAULT };

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
