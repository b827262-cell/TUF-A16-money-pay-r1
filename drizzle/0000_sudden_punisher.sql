CREATE TABLE `imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`file_hash` text NOT NULL,
	`source_kind` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imports_file_hash_unique` ON `imports` (`file_hash`);--> statement-breakpoint
CREATE TABLE `ocr_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`doc_type` text NOT NULL,
	`raw_text` text NOT NULL,
	`extracted_json` text DEFAULT '{}' NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`review_status` text DEFAULT 'reviewed' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ocr_documents_created_at_idx` ON `ocr_documents` (`created_at`);--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer,
	`asset_code` text,
	`asset_name` text NOT NULL,
	`asset_type` text NOT NULL,
	`currency` text DEFAULT 'TWD' NOT NULL,
	`units` real DEFAULT 0 NOT NULL,
	`avg_cost` real DEFAULT 0 NOT NULL,
	`market_price` real DEFAULT 0 NOT NULL,
	`cost_basis_twd` real DEFAULT 0 NOT NULL,
	`market_value_twd` real DEFAULT 0 NOT NULL,
	`pnl_twd` real DEFAULT 0 NOT NULL,
	`return_pct` real DEFAULT 0 NOT NULL,
	`dividend_twd` real DEFAULT 0 NOT NULL,
	`valuation_date` text,
	`source_kind` text NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `positions_asset_type_idx` ON `positions` (`asset_type`);--> statement-breakpoint
CREATE INDEX `positions_import_id_idx` ON `positions` (`import_id`);