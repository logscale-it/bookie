-- Add columns to track the last auto-backup attempt status and error
-- last_auto_backup_status: TEXT, expected values are 'success' or 'failure'
-- last_auto_backup_error: TEXT NULL, captures error message if status is 'failure'
ALTER TABLE settings_s3 ADD COLUMN last_auto_backup_status TEXT;
ALTER TABLE settings_s3 ADD COLUMN last_auto_backup_error TEXT;
