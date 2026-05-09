export interface Company {
  id: number;
  name: string;
  legal_name: string | null;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  country_code: string;
  tax_number: string | null;
  vat_id: string | null;
  bank_account_holder: string | null;
  bank_iban: string | null;
  bank_bic: string | null;
  bank_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: number;
  company_id: number;
  customer_number: string | null;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  country_code: string;
  vat_id: string | null;
  website: string | null;
  type: string;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: number;
  company_id: number;
  customer_id: number | null;
  project_number: string | null;
  name: string;
  description: string | null;
  status: string;
  hourly_rate: number | null;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface Invoice {
  id: number;
  company_id: number;
  customer_id: number;
  project_id: number | null;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  service_period_start: string | null;
  service_period_end: string | null;
  currency: string;
  net_amount: number;
  tax_amount: number;
  gross_amount: number;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  issuer_name: string | null;
  issuer_tax_number: string | null;
  issuer_vat_id: string | null;
  issuer_bank_account_holder: string | null;
  issuer_bank_iban: string | null;
  issuer_bank_bic: string | null;
  issuer_bank_name: string | null;
  recipient_name: string | null;
  recipient_street: string | null;
  recipient_postal_code: string | null;
  recipient_city: string | null;
  recipient_country_code: string | null;
  delivery_date: string | null;
  due_surcharge: number;
  language: string;
  legal_country_code: string;
  notes: string | null;
  s3_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceItem {
  id: number;
  invoice_id: number;
  project_id: number | null;
  time_entry_id: number | null;
  position: number;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price_net: number;
  tax_rate: number;
  line_total_net: number;
  unit_price_net_cents: number;
  line_total_net_cents: number;
  created_at: string;
  updated_at: string;
}

export interface TimeEntry {
  id: number;
  company_id: number;
  customer_id: number | null;
  project_id: number | null;
  entry_date: string;
  started_at: string | null;
  ended_at: string | null;
  duration_minutes: number | null;
  description: string | null;
  billable: number;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: number;
  invoice_id: number;
  payment_date: string;
  amount: number;
  amount_cents: number;
  method: string | null;
  reference: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceStatusHistory {
  id: number;
  invoice_id: number;
  from_status: string | null;
  to_status: string;
  changed_at: string;
  changed_by: string | null;
  note: string | null;
}

export interface OrganizationSettings {
  id: number;
  name: string;
  country: string;
  address: string;
  street: string;
  postal_code: string;
  city: string;
  email: string;
  phone_number: string;
  registering_id: string;
  bank_name: string;
  bank_iban: string;
  bank_account_holder: string;
  vatin: string;
  website: string;
  default_locale: string;
  default_legal_country: string;
  created_at: string;
  updated_at: string;
}

export interface InvoiceSettings {
  id: number;
  currency: string;
  decimal_places: number;
  days_till_due: number;
  due_surcharge: number;
  notes: string;
  invoice_number_format: string;
  invoice_number_incrementor: number;
  company_logo_data_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface VatTax {
  id: number;
  name: string;
  description: string;
  goods_value_percent: number;
  created_at: string;
  updated_at: string;
}

export interface IncomingInvoice {
  id: number;
  company_id: number;
  supplier_id: number | null;
  invoice_number: string | null;
  invoice_date: string;
  net_amount: number;
  tax_amount: number;
  gross_amount: number;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  status: string;
  file_data: number[] | null;
  file_name: string | null;
  file_type: string | null;
  s3_key: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface S3Settings {
  id: number;
  enabled: number;
  endpoint_url: string;
  region: string;
  bucket_name: string;
  access_key_id: string;
  secret_access_key: string;
  path_prefix: string;
  auto_backup_enabled: number;
  last_auto_backup_at: string | null;
  created_at: string;
  updated_at: string;
}
