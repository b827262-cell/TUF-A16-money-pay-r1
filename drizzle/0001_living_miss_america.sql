CREATE TABLE `portfolio_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_date` text NOT NULL,
	`position_count` integer DEFAULT 0 NOT NULL,
	`cost_basis_twd` real DEFAULT 0 NOT NULL,
	`market_value_twd` real DEFAULT 0 NOT NULL,
	`pnl_twd` real DEFAULT 0 NOT NULL,
	`dividend_twd` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_snapshots_date_unique` ON `portfolio_snapshots` (`snapshot_date`);