ALTER TABLE `organizations` ADD `event_allowance` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `organizations` SET `event_allowance` = MAX(1, (SELECT COUNT(*) FROM `events` e WHERE e.`org_id` = `organizations`.`id`));
