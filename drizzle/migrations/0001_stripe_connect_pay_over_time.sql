ALTER TABLE `checkout_pages` ADD `pay_over_time` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `stripe_accounts` ADD `pay_methods` text DEFAULT '{"card":"","klarna":"","afterpay":""}' NOT NULL;--> statement-breakpoint
ALTER TABLE `stripe_accounts` ADD `connected_via` text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE `stripe_accounts` ADD `livemode` integer DEFAULT true NOT NULL;