ALTER TABLE `imports` ADD `as_of_date` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `parser_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `imports_source_kind_status_as_of_idx` ON `imports` (`source_kind`,`status`,`as_of_date`);--> statement-breakpoint
-- Backfill: batches created before this migration had no statistics date and were applied
-- as soon as their rows landed, so treat the ones that do own positions as applied.
-- created_at is UTC CURRENT_TIMESTAMP, so shift +8 hours to get the Taipei calendar date
-- the user actually imported on.
UPDATE `imports` SET `as_of_date` = COALESCE(`as_of_date`, date(`created_at`, '+8 hours')), `status` = 'applied'
WHERE `status` = 'pending' AND EXISTS (SELECT 1 FROM `positions` p WHERE p.`import_id` = `imports`.`id`);--> statement-breakpoint
-- Only now that every legacy batch has a statistics date can the idempotency key widen: the same bytes
-- legitimately describe 2026-08-24 and 2026-08-31 when nothing moved in between.
DROP INDEX `imports_file_hash_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `imports_file_hash_source_as_of_unique` ON `imports` (`file_hash`,`source_kind`,`as_of_date`);