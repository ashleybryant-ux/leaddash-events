ALTER TABLE `vendors` ADD `hold_notice_at` integer;--> statement-breakpoint
ALTER TABLE `vendors` ADD `pay_session_id` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `pay_session_expires_at` integer;--> statement-breakpoint
ALTER TABLE `vendor_checkouts` ADD `pending_at` integer;--> statement-breakpoint
ALTER TABLE `vendor_payments` ADD `stripe_idempotency_key` text;--> statement-breakpoint
-- A payment recorded twice for one session before this index keeps its row (the money still shows), but only the first keeps the session id, so the index can be built.
UPDATE `vendor_payments` SET `stripe_session_id` = NULL WHERE `stripe_session_id` IS NOT NULL AND `id` NOT IN (SELECT MIN(`id`) FROM `vendor_payments` WHERE `stripe_session_id` IS NOT NULL GROUP BY `stripe_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_payments_session` ON `vendor_payments` (`stripe_session_id`);