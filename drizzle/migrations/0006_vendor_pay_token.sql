ALTER TABLE `vendors` ADD `pay_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_pay_token_unique` ON `vendors` (`pay_token`);