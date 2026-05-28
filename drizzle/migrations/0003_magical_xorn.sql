ALTER TABLE `imap_credentials` ADD `sync_cursor_at` integer;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `last_sync_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `last_sync_success_at` integer;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `last_sync_failure_at` integer;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `last_sync_error` text;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `last_imported_email_at` integer;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `last_imported_email_date` integer;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `backoff_until` integer;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `lock_owner` text;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `lock_expires_at` integer;