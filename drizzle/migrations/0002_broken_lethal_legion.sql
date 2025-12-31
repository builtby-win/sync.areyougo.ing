ALTER TABLE `sync_history` ADD `credential_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `unique_user_imap_email` ON `imap_credentials` (`user_id`,`imap_email`);