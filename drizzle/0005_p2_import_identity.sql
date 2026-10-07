CREATE TABLE `account_source_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mapping_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`account_key` text NOT NULL,
	`scope_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_source_mappings_key_source_unique` ON `account_source_mappings` (`mapping_key`,`source_kind`);--> statement-breakpoint
CREATE INDEX `account_source_mappings_status_idx` ON `account_source_mappings` (`status`);--> statement-breakpoint
CREATE INDEX `account_source_mappings_account_scope_idx` ON `account_source_mappings` (`account_key`,`scope_key`);--> statement-breakpoint
CREATE TABLE `asset_alias_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`asset_class` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`approved_by` text NOT NULL,
	`approved_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_alias_class_alias_unique` ON `asset_alias_mappings` (`asset_class`,`normalized_alias`);--> statement-breakpoint
CREATE INDEX `asset_alias_asset_id_idx` ON `asset_alias_mappings` (`asset_id`);--> statement-breakpoint
CREATE TABLE `asset_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`code_type` text NOT NULL,
	`normalized_code` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_codes_type_code_unique` ON `asset_codes` (`code_type`,`normalized_code`);--> statement-breakpoint
CREATE INDEX `asset_codes_asset_id_idx` ON `asset_codes` (`asset_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_class` text NOT NULL,
	`canonical_name` text NOT NULL,
	`currency` text,
	`share_class` text,
	`distribution_mode` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assets_identity_lookup_idx` ON `assets` (`asset_class`,`canonical_name`,`currency`,`share_class`,`distribution_mode`);--> statement-breakpoint
CREATE TABLE `cutover_managed_scopes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_key` text NOT NULL,
	`scope_key` text NOT NULL,
	`status` text DEFAULT 'shadow' NOT NULL,
	`owner_approved` integer DEFAULT 0 NOT NULL,
	`approved_at` text,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cutover_managed_scopes_account_scope_unique` ON `cutover_managed_scopes` (`account_key`,`scope_key`);--> statement-breakpoint
CREATE INDEX `cutover_managed_scopes_status_approved_idx` ON `cutover_managed_scopes` (`status`,`owner_approved`);--> statement-breakpoint
CREATE TABLE `import_quarantine` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer,
	`kind` text NOT NULL,
	`reason_code` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_quarantine_status_reason_idx` ON `import_quarantine` (`status`,`reason_code`);--> statement-breakpoint
CREATE INDEX `import_quarantine_import_id_idx` ON `import_quarantine` (`import_id`);--> statement-breakpoint
CREATE TABLE `portfolio_snapshot_imports` (
	`snapshot_id` integer NOT NULL,
	`import_id` integer NOT NULL,
	PRIMARY KEY(`snapshot_id`, `import_id`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `portfolio_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `portfolio_snapshot_imports_import_id_idx` ON `portfolio_snapshot_imports` (`import_id`);--> statement-breakpoint
DROP INDEX `imports_file_hash_source_as_of_unique`;--> statement-breakpoint
ALTER TABLE `imports` ADD `account_key` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `account_key_basis` text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `scope_key` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `source_role` text DEFAULT 'supplemental' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `coverage_type` text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `logical_import_key` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `logical_import_key_version` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `canonical_content_hash` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `source_native_import_id` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `source_mapping_key` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `supersedes_import_id` integer REFERENCES imports(id);--> statement-breakpoint
CREATE UNIQUE INDEX `imports_legacy_file_hash_source_as_of_unique` ON `imports` (`file_hash`,`source_kind`,`as_of_date`) WHERE "imports"."account_key" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `imports_p2_account_file_source_as_of_unique` ON `imports` (`account_key`,`scope_key`,`file_hash`,`source_kind`,`as_of_date`) WHERE "imports"."account_key" IS NOT NULL AND "imports"."scope_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `imports_p2_logical_import_key_idx` ON `imports` (`logical_import_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `imports_p2_logical_content_unique` ON `imports` (`logical_import_key`,`canonical_content_hash`) WHERE "imports"."logical_import_key" IS NOT NULL AND "imports"."canonical_content_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `imports_current_scope_idx` ON `imports` (`status`,`source_role`,`coverage_type`,`account_key`,`scope_key`,`as_of_date`);--> statement-breakpoint
CREATE INDEX `imports_supersedes_import_id_idx` ON `imports` (`supersedes_import_id`);--> statement-breakpoint
ALTER TABLE `positions` ADD `asset_id` integer REFERENCES assets(id);--> statement-breakpoint
CREATE INDEX `positions_asset_id_idx` ON `positions` (`asset_id`);