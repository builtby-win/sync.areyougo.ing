-- Initial schema for sync.areyougo.ing
-- imap_credentials: stores encrypted IMAP login details per user
-- sync_history: audit log of sync operations for debugging

CREATE TABLE `imap_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text NOT NULL,
	`provider` text NOT NULL,
	`imap_email` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 993 NOT NULL,
	`encrypted_password` text NOT NULL,
	`iv` text NOT NULL,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`emails_found` integer DEFAULT 0,
	`emails_ingested` integer DEFAULT 0,
	`error_message` text,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
