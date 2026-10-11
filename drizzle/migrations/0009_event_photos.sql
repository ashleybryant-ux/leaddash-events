CREATE TABLE `event_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`attendee_id` integer,
	`uploaded_by_user_id` integer,
	`file_id` integer NOT NULL,
	`thumb_file_id` integer,
	`caption` text DEFAULT '' NOT NULL,
	`session_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`reported` integer DEFAULT false NOT NULL,
	`reviewed_by` integer,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thumb_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `event_photos_event` ON `event_photos` (`event_id`,`status`);--> statement-breakpoint
CREATE TABLE `photo_likes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `event_photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_likes_unique` ON `photo_likes` (`photo_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `photo_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`review` integer DEFAULT true NOT NULL,
	`who` text DEFAULT 'everyone' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_settings_event_id_unique` ON `photo_settings` (`event_id`);
--> statement-breakpoint
UPDATE `events` SET `features` = json_set(`features`, '$.photos', json('true')) WHERE json_extract(`features`, '$.photos') IS NULL;
