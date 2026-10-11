ALTER TABLE `checkout_pages` ADD `buyer_types` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket_types` ADD `early_ends_on` text;--> statement-breakpoint
ALTER TABLE `ticket_types` ADD `early_price_cents` integer;--> statement-breakpoint
ALTER TABLE `ticket_types` ADD `late_starts_on` text;--> statement-breakpoint
ALTER TABLE `ticket_types` ADD `late_price_cents` integer;--> statement-breakpoint
ALTER TABLE `ticket_types` ADD `buyer_types` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket_types` ADD `buyer_prices` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `ticket_types` SET `early_ends_on` = (SELECT s.`sale_ends_on` FROM `ticket_types` s WHERE s.`switch_to_ticket_id` = `ticket_types`.`id` AND s.`after_sale` = 'switch' AND s.`active` = 1 AND s.`sale_ends_on` IS NOT NULL ORDER BY s.`id` LIMIT 1), `early_price_cents` = (SELECT s.`price_cents` FROM `ticket_types` s WHERE s.`switch_to_ticket_id` = `ticket_types`.`id` AND s.`after_sale` = 'switch' AND s.`active` = 1 AND s.`sale_ends_on` IS NOT NULL ORDER BY s.`id` LIMIT 1), `active` = 1 WHERE `early_ends_on` IS NULL AND EXISTS (SELECT 1 FROM `ticket_types` s WHERE s.`switch_to_ticket_id` = `ticket_types`.`id` AND s.`after_sale` = 'switch' AND s.`active` = 1 AND s.`sale_ends_on` IS NOT NULL AND s.`price_cents` < `ticket_types`.`price_cents`);--> statement-breakpoint
UPDATE `ticket_types` SET `active` = 0, `after_sale` = 'close', `switch_to_ticket_id` = NULL WHERE `after_sale` = 'switch' AND `active` = 1 AND EXISTS (SELECT 1 FROM `ticket_types` t WHERE t.`id` = `ticket_types`.`switch_to_ticket_id` AND t.`early_price_cents` = `ticket_types`.`price_cents`);
