-- Drop the auto-backup status tracking columns
ALTER TABLE settings_s3 DROP COLUMN last_auto_backup_status;
ALTER TABLE settings_s3 DROP COLUMN last_auto_backup_error;
