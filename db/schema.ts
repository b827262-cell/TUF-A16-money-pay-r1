import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const imports = sqliteTable("imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  fileHash: text("file_hash").notNull(),
  sourceKind: text("source_kind").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  asOfDate: text("as_of_date"),
  status: text("status").notNull().default("pending"),
  parserVersion: integer("parser_version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // Same bytes can legitimately describe different statistics dates, so idempotency covers the file plus what it claims to measure.
  uniqueIndex("imports_file_hash_source_as_of_unique").on(table.fileHash, table.sourceKind, table.asOfDate),
  index("imports_source_kind_status_as_of_idx").on(table.sourceKind, table.status, table.asOfDate),
]);

export const positions = sqliteTable("positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importId: integer("import_id").references(() => imports.id),
  assetCode: text("asset_code"),
  assetName: text("asset_name").notNull(),
  assetType: text("asset_type").notNull(),
  currency: text("currency").notNull().default("TWD"),
  units: real("units").notNull().default(0),
  avgCost: real("avg_cost").notNull().default(0),
  marketPrice: real("market_price").notNull().default(0),
  costBasisTwd: real("cost_basis_twd").notNull().default(0),
  marketValueTwd: real("market_value_twd").notNull().default(0),
  pnlTwd: real("pnl_twd").notNull().default(0),
  returnPct: real("return_pct").notNull().default(0),
  dividendTwd: real("dividend_twd").notNull().default(0),
  valuationDate: text("valuation_date"),
  lastPurchaseDate: text("last_purchase_date"),
  purchaseDateBasis: text("purchase_date_basis").notNull().default("unknown"),
  assetCategory: text("asset_category"),
  investRegion: text("invest_region"),
  marketCapTier: text("market_cap_tier"),
  investStyle: text("invest_style"),
  industryTheme: text("industry_theme"),
  sourceKind: text("source_kind").notNull(),
  rawJson: text("raw_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("positions_asset_type_idx").on(table.assetType),
  index("positions_import_id_idx").on(table.importId),
  index("positions_asset_category_idx").on(table.assetCategory),
  index("positions_last_purchase_date_idx").on(table.lastPurchaseDate),
]);

export const ocrDocuments = sqliteTable("ocr_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  docType: text("doc_type").notNull(),
  rawText: text("raw_text").notNull(),
  extractedJson: text("extracted_json").notNull().default("{}"),
  confidence: real("confidence").notNull().default(0),
  reviewStatus: text("review_status").notNull().default("reviewed"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("ocr_documents_created_at_idx").on(table.createdAt)]);

export const portfolioSnapshots = sqliteTable("portfolio_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(),
  positionCount: integer("position_count").notNull().default(0),
  costBasisTwd: real("cost_basis_twd").notNull().default(0),
  marketValueTwd: real("market_value_twd").notNull().default(0),
  pnlTwd: real("pnl_twd").notNull().default(0),
  dividendTwd: real("dividend_twd").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("portfolio_snapshots_date_unique").on(table.snapshotDate)]);
