ALTER TABLE `imap_credentials` ADD `sync_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `imap_credentials` ADD `last_manual_sync_at` integer;