CREATE TABLE `host_people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`workplace` text DEFAULT '' NOT NULL,
	`group_label` text DEFAULT 'Our team' NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`photo_file_id` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `host_people_event` ON `host_people` (`event_id`);--> statement-breakpoint
ALTER TABLE `events` ADD `venue_address2` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `state` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `zip` text DEFAULT '' NOT NULL;