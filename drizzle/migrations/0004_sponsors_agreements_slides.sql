CREATE TABLE `agreement_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`sign_when` text DEFAULT 'checkout' NOT NULL,
	`send_on_accept` integer DEFAULT true NOT NULL,
	`send_on_add` integer DEFAULT true NOT NULL,
	`reminder_days` integer DEFAULT 3 NOT NULL,
	`reminder_max` integer DEFAULT 3 NOT NULL,
	`ask_recording` integer DEFAULT false NOT NULL,
	`signer_name` text DEFAULT '' NOT NULL,
	`signer_title` text DEFAULT '' NOT NULL,
	`countersign` integer DEFAULT true NOT NULL,
	`values` text DEFAULT '{}' NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agreement_templates_event` ON `agreement_templates` (`event_id`);--> statement-breakpoint
CREATE TABLE `agreements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`template_id` integer,
	`kind` text NOT NULL,
	`vendor_id` integer,
	`speaker_id` integer,
	`checkout_id` integer,
	`code` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`html` text DEFAULT '' NOT NULL,
	`signer_email` text DEFAULT '' NOT NULL,
	`signer_name` text DEFAULT '' NOT NULL,
	`signer_title` text DEFAULT '' NOT NULL,
	`signature_file_id` integer,
	`recording_allowed` integer,
	`countersign_name` text DEFAULT '' NOT NULL,
	`countersign_title` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`sent_at` integer,
	`reminders_sent` integer DEFAULT 0 NOT NULL,
	`last_reminder_at` integer,
	`signed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `agreement_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`speaker_id`) REFERENCES `speakers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`signature_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agreements_code_unique` ON `agreements` (`code`);--> statement-breakpoint
CREATE INDEX `agreements_event` ON `agreements` (`event_id`);--> statement-breakpoint
CREATE INDEX `agreements_vendor` ON `agreements` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `agreements_speaker` ON `agreements` (`speaker_id`);--> statement-breakpoint
CREATE TABLE `recipient_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`recipient_type` text NOT NULL,
	`recipient_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipient_log_once` ON `recipient_log` (`recipient_type`,`recipient_id`,`kind`);--> statement-breakpoint
CREATE TABLE `session_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`session_id` integer NOT NULL,
	`file_id` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`uploaded_by_speaker_id` integer,
	`uploaded_by_user_id` integer,
	`downloads` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_speaker_id`) REFERENCES `speakers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_files_session` ON `session_files` (`session_id`);--> statement-breakpoint
CREATE TABLE `vendor_addons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer DEFAULT 0 NOT NULL,
	`quantity` integer,
	`package_ids` text DEFAULT '[]' NOT NULL,
	`adds_pass` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vendor_addons_event` ON `vendor_addons` (`event_id`);--> statement-breakpoint
CREATE TABLE `vendor_checkout_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`kind` text NOT NULL,
	`open` integer DEFAULT false NOT NULL,
	`closes_on` text,
	`title` text DEFAULT '' NOT NULL,
	`intro` text DEFAULT '' NOT NULL,
	`package_ids` text DEFAULT '[]' NOT NULL,
	`pay_full` integer DEFAULT true NOT NULL,
	`pay_deposit` integer DEFAULT false NOT NULL,
	`pay_invoice` integer DEFAULT false NOT NULL,
	`methods` text DEFAULT 'both' NOT NULL,
	`deposit_percent` integer DEFAULT 50 NOT NULL,
	`balance_due_on` text,
	`invoice_hold_days` integer DEFAULT 14 NOT NULL,
	`agreement_template_id` integer,
	`notify_email` text DEFAULT '' NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_checkout_pages_kind` ON `vendor_checkout_pages` (`event_id`,`kind`);--> statement-breakpoint
CREATE TABLE `vendor_checkouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`kind` text NOT NULL,
	`package_id` integer NOT NULL,
	`buyer` text NOT NULL,
	`pay_option` text DEFAULT 'full' NOT NULL,
	`total_cents` integer NOT NULL,
	`due_today_cents` integer NOT NULL,
	`agreement_id` integer,
	`status` text DEFAULT 'started' NOT NULL,
	`stripe_account_id` text,
	`stripe_session_id` text,
	`vendor_id` integer,
	`done_token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_checkouts_stripe_session_id_unique` ON `vendor_checkouts` (`stripe_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_checkouts_done_token_unique` ON `vendor_checkouts` (`done_token`);--> statement-breakpoint
CREATE INDEX `vendor_checkouts_event` ON `vendor_checkouts` (`event_id`);--> statement-breakpoint
CREATE TABLE `vendor_packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`kind` text DEFAULT 'sponsor' NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price_cents` integer DEFAULT 0 NOT NULL,
	`quantity` integer,
	`passes` integer DEFAULT 0 NOT NULL,
	`pass_ticket_type_id` integer,
	`includes_booth` integer DEFAULT false NOT NULL,
	`logo_spots` text DEFAULT '{"welcome":false,"topOfList":false,"sessionPages":false}' NOT NULL,
	`benefits` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pass_ticket_type_id`) REFERENCES `ticket_types`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `vendor_packages_event` ON `vendor_packages` (`event_id`);--> statement-breakpoint
CREATE TABLE `vendor_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`vendor_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text DEFAULT 'other' NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`purpose` text DEFAULT 'manual' NOT NULL,
	`paid_on` text DEFAULT '' NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`stripe_account_id` text,
	`stripe_session_id` text,
	`stripe_payment_intent_id` text,
	`failure_reason` text DEFAULT '' NOT NULL,
	`recorded_by` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `vendor_payments_vendor` ON `vendor_payments` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `vendor_payments_pi` ON `vendor_payments` (`stripe_payment_intent_id`);--> statement-breakpoint
ALTER TABLE `attendees` ADD `vendor_id` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `method` text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `reference` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `paid_on` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `recorded_by` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `slides_share` text DEFAULT 'after_start' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `slides_due_on` text;--> statement-breakpoint
ALTER TABLE `speakers` ADD `portal_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_portal_token_unique` ON `speakers` (`portal_token`);--> statement-breakpoint
ALTER TABLE `vendors` ADD `package_id` integer;--> statement-breakpoint
ALTER TABLE `vendors` ADD `addons` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `next_charge_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `next_charge_on` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `next_charge_reminder_at` integer;--> statement-breakpoint
ALTER TABLE `vendors` ADD `next_charge_error` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `stripe_payment_method_id` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `pay_method_label` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `hold_until` text;