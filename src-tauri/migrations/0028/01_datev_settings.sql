-- DATEV Buchungsstapel export settings. Consultant + client number identify
-- the Steuerberater's DATEV Bestand (written into the EXTF header so the
-- import lands in the right Mandant); SKR selects the chart of accounts used
-- for the generated contra accounts.
ALTER TABLE settings_organization ADD COLUMN datev_consultant_number TEXT NOT NULL DEFAULT '';
ALTER TABLE settings_organization ADD COLUMN datev_client_number TEXT NOT NULL DEFAULT '';
ALTER TABLE settings_organization ADD COLUMN datev_skr TEXT NOT NULL DEFAULT '03' CHECK (datev_skr IN ('03', '04'));
