CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer,
	`event_id` integer,
	`user_id` integer,
	`action` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_event` ON `audit_log` (`event_id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_hash_unique` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`short_name` text DEFAULT '' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`timezone` text DEFAULT 'America/Chicago' NOT NULL,
	`venue_name` text DEFAULT '' NOT NULL,
	`venue_address` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`capacity` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`branding` text DEFAULT '{"colorPrimary":"#1F5F4A","colorAccent":"#e88a3a"}' NOT NULL,
	`host_name` text DEFAULT '' NOT NULL,
	`host_about` text DEFAULT '' NOT NULL,
	`host_mission` text DEFAULT '' NOT NULL,
	`host_image_file_id` integer,
	`host_links` text DEFAULT '[]' NOT NULL,
	`host_join_url` text DEFAULT '' NOT NULL,
	`features` text DEFAULT '{"networking":true,"community":true,"messaging":true,"meetings":true,"polls":true,"exhibitors":true,"dining":true}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE INDEX `events_org` ON `events` (`org_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`is_public` integer DEFAULT true NOT NULL,
	`uploaded_by` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_key_unique` ON `files` (`key`);--> statement-breakpoint
CREATE TABLE `login_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_codes_email` ON `login_codes` (`email`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`event_id` integer,
	`kind` text DEFAULT 'general' NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user` ON `notifications` (`user_id`);--> statement-breakpoint
CREATE TABLE `org_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_members_unique` ON `org_members` (`org_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo_file_id` integer,
	`color_primary` text DEFAULT '#1F5F4A' NOT NULL,
	`color_accent` text DEFAULT '#e88a3a' NOT NULL,
	`platform_location_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `platform_auth` (
	`id` integer PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`sent_at` integer,
	`next_try_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_user` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `staff_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`vendor_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `staff_roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_assignments_unique` ON `staff_assignments` (`role_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `staff_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`access` text DEFAULT '{}' NOT NULL,
	`ends_with_event` integer DEFAULT true NOT NULL,
	`sign_in_with` text DEFAULT 'email' NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `staff_roles_event` ON `staff_roles` (`event_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`phone` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_signed_in_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `attendees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`user_id` integer,
	`email` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`credentials` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`job_title` text DEFAULT '' NOT NULL,
	`organization` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`photo_file_id` integer,
	`interests` text DEFAULT '[]' NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`license_number` text DEFAULT '' NOT NULL,
	`license_state` text DEFAULT '' NOT NULL,
	`answers` text DEFAULT '{}' NOT NULL,
	`text_consent` integer DEFAULT false NOT NULL,
	`ticket_type_id` integer,
	`status` text DEFAULT 'registered' NOT NULL,
	`kind` text DEFAULT 'attendee' NOT NULL,
	`qr_token` text NOT NULL,
	`checked_in_at` integer,
	`checked_in_by` integer,
	`badge_printed_at` integer,
	`badge_prints` integer DEFAULT 0 NOT NULL,
	`app_opened_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ticket_type_id`) REFERENCES `ticket_types`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendees_qr_token_unique` ON `attendees` (`qr_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `attendees_event_email` ON `attendees` (`event_id`,`email`);--> statement-breakpoint
CREATE INDEX `attendees_user` ON `attendees` (`user_id`);--> statement-breakpoint
CREATE TABLE `checkout_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`cover_file_id` integer,
	`headline` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`button_label` text DEFAULT 'Register' NOT NULL,
	`ticket_ids` text DEFAULT '[]' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`show_confirmation` integer DEFAULT true NOT NULL,
	`send_welcome` integer DEFAULT true NOT NULL,
	`platform_tag` text DEFAULT '' NOT NULL,
	`embed_style` text DEFAULT 'inline' NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_pages_event_id_unique` ON `checkout_pages` (`event_id`);--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`code` text NOT NULL,
	`percent_off` integer,
	`amount_off_cents` integer,
	`max_uses` integer,
	`used` integer DEFAULT 0 NOT NULL,
	`ends_on` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_code` ON `coupons` (`event_id`,`code`);--> statement-breakpoint
CREATE TABLE `message_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_log_once` ON `message_log` (`attendee_id`,`kind`);--> statement-breakpoint
CREATE TABLE `message_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`kind` text NOT NULL,
	`channel` text DEFAULT 'email' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`send_rule` text DEFAULT 'after_payment' NOT NULL,
	`only_if_no_app` integer DEFAULT false NOT NULL,
	`from_name` text DEFAULT '' NOT NULL,
	`reply_to` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`includes` text DEFAULT '{"receipt":true,"getApp":true,"qr":true,"calendar":true,"hotel":false}' NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_templates_kind` ON `message_templates` (`event_id`,`kind`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`attendee_id` integer,
	`email` text NOT NULL,
	`ticket_type_id` integer NOT NULL,
	`coupon_id` integer,
	`subtotal_cents` integer NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`amount_cents` integer NOT NULL,
	`fee_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stripe_account_id` text,
	`stripe_session_id` text,
	`stripe_payment_intent_id` text,
	`done_token` text,
	`buyer` text DEFAULT '{}' NOT NULL,
	`paid_at` integer,
	`refunded_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_stripe_session_id_unique` ON `orders` (`stripe_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_done_token_unique` ON `orders` (`done_token`);--> statement-breakpoint
CREATE INDEX `orders_event` ON `orders` (`event_id`);--> statement-breakpoint
CREATE TABLE `stripe_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`account_id` text NOT NULL,
	`business_name` text DEFAULT '' NOT NULL,
	`charges_enabled` integer DEFAULT false NOT NULL,
	`payouts_enabled` integer DEFAULT false NOT NULL,
	`bank_last4` text DEFAULT '' NOT NULL,
	`payout_interval` text DEFAULT '' NOT NULL,
	`details_submitted` integer DEFAULT false NOT NULL,
	`statement_descriptor` text DEFAULT '' NOT NULL,
	`refund_policy` text DEFAULT '' NOT NULL,
	`connected_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_accounts_org_id_unique` ON `stripe_accounts` (`org_id`);--> statement-breakpoint
CREATE TABLE `ticket_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price_cents` integer DEFAULT 0 NOT NULL,
	`quantity` integer,
	`sale_ends_on` text,
	`after_sale` text DEFAULT 'close' NOT NULL,
	`switch_to_ticket_id` integer,
	`includes` text DEFAULT 'All days' NOT NULL,
	`audience` text DEFAULT 'anyone' NOT NULL,
	`ribbon` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_types_event` ON `ticket_types` (`event_id`);--> statement-breakpoint
CREATE TABLE `alert_prefs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attendee_id` integer NOT NULL,
	`reminders` integer DEFAULT true NOT NULL,
	`evaluations` integer DEFAULT true NOT NULL,
	`changes` integer DEFAULT true NOT NULL,
	`announcements` integer DEFAULT true NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_prefs_attendee_id_unique` ON `alert_prefs` (`attendee_id`);--> statement-breakpoint
CREATE TABLE `announcements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`audience` text DEFAULT 'everyone' NOT NULL,
	`ticket_type_id` integer,
	`session_id` integer,
	`draft` integer DEFAULT false NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`send_push` integer DEFAULT true NOT NULL,
	`send_email` integer DEFAULT false NOT NULL,
	`send_at` integer,
	`sent_at` integer,
	`recipients` integer DEFAULT 0 NOT NULL,
	`created_by` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `announcements_event` ON `announcements` (`event_id`);--> statement-breakpoint
CREATE TABLE `dining_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`date` text DEFAULT '' NOT NULL,
	`meal` text DEFAULT '' NOT NULL,
	`time` text DEFAULT '' NOT NULL,
	`end_time` text DEFAULT '' NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`dietary` text DEFAULT '[]' NOT NULL,
	`cuisine` text DEFAULT '' NOT NULL,
	`price` text DEFAULT '' NOT NULL,
	`walk_minutes` integer,
	`address` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dining_event` ON `dining_items` (`event_id`,`kind`);--> statement-breakpoint
CREATE TABLE `help_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`category` text DEFAULT 'General' NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `help_articles_event` ON `help_articles` (`event_id`);--> statement-breakpoint
CREATE TABLE `help_desks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`place` text DEFAULT '' NOT NULL,
	`hours` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`lost_found_note` text DEFAULT '' NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `help_desks_event_id_unique` ON `help_desks` (`event_id`);--> statement-breakpoint
CREATE TABLE `help_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`attendee_id` integer,
	`topic` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`replied_by` integer,
	`replied_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `help_requests_event` ON `help_requests` (`event_id`);--> statement-breakpoint
CREATE TABLE `lost_found` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`kind` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`item` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`place` text DEFAULT '' NOT NULL,
	`photo_file_id` integer,
	`attendee_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `lost_found_event` ON `lost_found` (`event_id`);--> statement-breakpoint
CREATE TABLE `schedule_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attendee_id` integer NOT NULL,
	`session_id` integer NOT NULL,
	`remind` integer DEFAULT true NOT NULL,
	`reminded_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_unique` ON `schedule_items` (`attendee_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `session_speakers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`speaker_id` integer NOT NULL,
	`role` text DEFAULT 'presenter' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`speaker_id`) REFERENCES `speakers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_speakers_unique` ON `session_speakers` (`session_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'session' NOT NULL,
	`date` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`room` text DEFAULT '' NOT NULL,
	`track` text DEFAULT '' NOT NULL,
	`ce_hours` real DEFAULT 0 NOT NULL,
	`capacity` integer,
	`requires_signup` integer DEFAULT false NOT NULL,
	`check_in_code` text NOT NULL,
	`evaluation_id` integer,
	`published` integer DEFAULT true NOT NULL,
	`proposal_id` integer,
	`evaluation_opens` text DEFAULT 'end' NOT NULL,
	`certificate_template_id` integer,
	`certificate_after` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_event` ON `sessions` (`event_id`,`date`);--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`credentials` text DEFAULT '' NOT NULL,
	`job_title` text DEFAULT '' NOT NULL,
	`organization` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`headshot_file_id` integer,
	`website` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`user_id` integer,
	`allow_messages` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`headshot_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `speakers_event` ON `speakers` (`event_id`);--> statement-breakpoint
CREATE TABLE `certificate_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`title` text DEFAULT 'Certificate of Attendance' NOT NULL,
	`provider_name` text DEFAULT '' NOT NULL,
	`provider_number` text DEFAULT '' NOT NULL,
	`approval_text` text DEFAULT '' NOT NULL,
	`signer_name` text DEFAULT '' NOT NULL,
	`signer_title` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT 'session' NOT NULL,
	`require_evaluation` integer DEFAULT true NOT NULL,
	`min_minutes` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT true NOT NULL,
	`signature_style` text DEFAULT 'script' NOT NULL,
	`signature_file_id` integer,
	`show` text DEFAULT '{"credentials":true,"sessionTitle":true,"sessionDate":true,"hours":true,"code":true,"presenter":false}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `certificate_templates_event` ON `certificate_templates` (`event_id`);--> statement-breakpoint
CREATE TABLE `certificates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`session_id` integer,
	`template_id` integer,
	`title` text NOT NULL,
	`hours` real NOT NULL,
	`code` text NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_id`) REFERENCES `certificate_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `certificates_code_unique` ON `certificates` (`code`);--> statement-breakpoint
CREATE INDEX `certificates_attendee` ON `certificates` (`attendee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `certificate_once` ON `certificates` (`attendee_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `evaluation_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evaluation_reminder_once` ON `evaluation_reminders` (`session_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `evaluation_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evaluation_id` integer NOT NULL,
	`session_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`answers` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evaluation_once` ON `evaluation_responses` (`session_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`closes_after_hours` integer DEFAULT 720 NOT NULL,
	`opens_at` text DEFAULT 'session_end' NOT NULL,
	`needed_for_certificate` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evaluations_event` ON `evaluations` (`event_id`);--> statement-breakpoint
CREATE TABLE `session_checkins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`method` text DEFAULT 'qr' NOT NULL,
	`checked_out_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_checkin_once` ON `session_checkins` (`session_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attendee_id` integer NOT NULL,
	`blocked_attendee_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_unique` ON `blocks` (`attendee_id`,`blocked_attendee_id`);--> statement-breakpoint
CREATE TABLE `cfp_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`opens_on` text,
	`closes_on` text,
	`intro` text DEFAULT '' NOT NULL,
	`formats` text DEFAULT '["Breakout session (60 min)","Workshop (90 min)","Poster"]' NOT NULL,
	`tracks` text DEFAULT '[]' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`rubric` text DEFAULT '[{"key":"relevance","label":"Relevance","max":5},{"key":"evidence","label":"Evidence base","max":5},{"key":"objectives","label":"Learning objectives","max":5}]' NOT NULL,
	`blind` integer DEFAULT true NOT NULL,
	`reviewers_per_proposal` integer DEFAULT 2 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cfp_settings_event_id_unique` ON `cfp_settings` (`event_id`);--> statement-breakpoint
CREATE TABLE `channel_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`last_read_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_members_unique` ON `channel_members` (`channel_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'General' NOT NULL,
	`created_by_attendee_id` integer,
	`official` integer DEFAULT false NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`last_post_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channels_event` ON `channels` (`event_id`);--> statement-breakpoint
CREATE TABLE `community_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`who_can_start` text DEFAULT 'attendees' NOT NULL,
	`exhibitor_posting` text DEFAULT 'own' NOT NULL,
	`hide_after_reports` integer DEFAULT 3,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_settings_event_id_unique` ON `community_settings` (`event_id`);--> statement-breakpoint
CREATE TABLE `floor_maps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`file_id` integer,
	`pins` text DEFAULT '[]' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`scanned_by` integer,
	`rating` text DEFAULT 'warm' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scanned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_unique` ON `leads` (`vendor_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `meeting_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`from_attendee_id` integer NOT NULL,
	`to_attendee_id` integer NOT NULL,
	`date` text NOT NULL,
	`start_time` text NOT NULL,
	`minutes` integer DEFAULT 30 NOT NULL,
	`place` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meetings_event` ON `meeting_requests` (`event_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_thread` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poll_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`option` integer NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poll_votes_unique` ON `poll_votes` (`poll_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`question` text NOT NULL,
	`options` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polls_session` ON `polls` (`session_id`);--> statement-breakpoint
CREATE TABLE `post_likes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_likes_unique` ON `post_likes` (`post_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `post_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_reports_unique` ON `post_reports` (`post_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`attendee_id` integer,
	`by_event` integer DEFAULT false NOT NULL,
	`parent_id` integer,
	`body` text NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`reported` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `posts_channel` ON `posts` (`channel_id`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`user_id` integer,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`credentials` text DEFAULT '' NOT NULL,
	`organization` text DEFAULT '' NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`headshot_file_id` integer,
	`title` text NOT NULL,
	`abstract` text NOT NULL,
	`objectives` text DEFAULT '[]' NOT NULL,
	`format` text DEFAULT '' NOT NULL,
	`track` text DEFAULT '' NOT NULL,
	`ce_requested` integer DEFAULT true NOT NULL,
	`co_presenters` text DEFAULT '[]' NOT NULL,
	`answers` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`decision_note` text DEFAULT '' NOT NULL,
	`notified_at` integer,
	`session_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `proposals_event` ON `proposals` (`event_id`);--> statement-breakpoint
CREATE TABLE `question_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `session_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_votes_unique` ON `question_votes` (`question_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `review_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` integer NOT NULL,
	`reviewer_user_id` integer NOT NULL,
	`scores` text,
	`comment` text DEFAULT '' NOT NULL,
	`recommendation` text,
	`submitted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignments_unique` ON `review_assignments` (`proposal_id`,`reviewer_user_id`);--> statement-breakpoint
CREATE TABLE `session_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`attendee_id` integer,
	`anonymous` integer DEFAULT false NOT NULL,
	`body` text NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`answered` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_questions_session` ON `session_questions` (`session_id`);--> statement-breakpoint
CREATE TABLE `thread_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`attendee_id` integer NOT NULL,
	`last_read_at` integer,
	`last_read_message_id` integer DEFAULT 0 NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_members_unique` ON `thread_members` (`thread_id`,`attendee_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`last_message_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `threads_event` ON `threads` (`event_id`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`company` text NOT NULL,
	`kind` text DEFAULT 'exhibitor' NOT NULL,
	`level` text DEFAULT '' NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`booth` text DEFAULT '' NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'lead' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`logo_file_id` integer,
	`contract_file_id` integer,
	`benefits` text DEFAULT '[]' NOT NULL,
	`booth_staff` text DEFAULT '[]' NOT NULL,
	`offer` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`lead_scanning` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`logo_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contract_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `vendors_event` ON `vendors` (`event_id`);--> statement-breakpoint
CREATE TABLE `ce_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`email` text NOT NULL,
	`title` text NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`date` text NOT NULL,
	`hours` real NOT NULL,
	`certificate_file_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ce_entries_email` ON `ce_entries` (`org_id`,`email`);--> statement-breakpoint
CREATE TABLE `doc_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`name` text NOT NULL,
	`access` text DEFAULT '{"type":"active_members"}' NOT NULL,
	`group_id` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_folders_org` ON `doc_folders` (`org_id`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`version` integer NOT NULL,
	`file_id` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`uploaded_by` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_unique` ON `document_versions` (`document_id`,`version`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`folder_id` integer NOT NULL,
	`title` text NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`notify` text DEFAULT 'push_email' NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `doc_folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_folder` ON `documents` (`folder_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`member_id` integer NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_members_unique` ON `group_members` (`group_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `group_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`member_id` integer,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `group_posts_group` ON `group_posts` (`group_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'committee' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`join_rule` text DEFAULT 'appointment' NOT NULL,
	`join_level` text DEFAULT '' NOT NULL,
	`term_ends_on` text,
	`has_channel` integer DEFAULT true NOT NULL,
	`has_folder` integer DEFAULT true NOT NULL,
	`chair_can_email` integer DEFAULT true NOT NULL,
	`chair_can_add` integer DEFAULT false NOT NULL,
	`next_meeting` text DEFAULT '' NOT NULL,
	`is_board` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `groups_org` ON `groups` (`org_id`);--> statement-breakpoint
CREATE TABLE `member_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`number_prefix` text DEFAULT '' NOT NULL,
	`renew_url` text DEFAULT '' NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_settings_org_id_unique` ON `member_settings` (`org_id`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`user_id` integer,
	`email` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`credentials` text DEFAULT '' NOT NULL,
	`level` text DEFAULT 'Professional' NOT NULL,
	`member_number` text NOT NULL,
	`member_since` text DEFAULT '' NOT NULL,
	`expires_on` text,
	`status` text DEFAULT 'active' NOT NULL,
	`auto_renew` integer DEFAULT false NOT NULL,
	`photo_file_id` integer,
	`card_token` text NOT NULL,
	`platform_contact_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`photo_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_card_token_unique` ON `members` (`card_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_org_email` ON `members` (`org_id`,`email`);--> statement-breakpoint
CREATE INDEX `members_user` ON `members` (`user_id`);--> statement-breakpoint
CREATE TABLE `program_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`program_id` integer NOT NULL,
	`email` text NOT NULL,
	`rating` integer,
	`date` text NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `program_participants_program` ON `program_participants` (`program_id`);--> statement-breakpoint
CREATE TABLE `programs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `report_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`email` text NOT NULL,
	`frequency` text DEFAULT 'monthly' NOT NULL,
	`range` text DEFAULT '12m' NOT NULL,
	`level` text DEFAULT '' NOT NULL,
	`next_send_at` integer NOT NULL,
	`last_sent_at` integer,
	`created_by` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `report_schedules_org` ON `report_schedules` (`org_id`);