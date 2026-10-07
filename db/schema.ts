import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const imports = sqliteTable("imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  fileHash: text("file_hash").notNull(),
  sourceKind: text("source_kind").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  asOfDate: text("as_of_date"),
  status: text("status").notNull().default("pending"),
  parserVersion: integer("parser_version").notNull().default(1),
  accountKey: text("account_key"),
  accountKeyBasis: text("account_key_basis").notNull().default("legacy_unknown"),
  scopeKey: text("scope_key"),
  sourceRole: text("source_role").notNull().default("supplemental"),
  coverageType: text("coverage_type").notNull().default("legacy_unknown"),
  logicalImportKey: text("logical_import_key"),
  logicalImportKeyVersion: text("logical_import_key_version"),
  canonicalContentHash: text("canonical_content_hash"),
  sourceNativeImportId: text("source_native_import_id"),
  sourceMappingKey: text("source_mapping_key"),
  supersedesImportId: integer("supersedes_import_id").references((): AnySQLiteColumn => imports.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // Preserve legacy idempotency semantics without blocking account-aware P2 imports.
  uniqueIndex("imports_legacy_file_hash_source_as_of_unique")
    .on(table.fileHash, table.sourceKind, table.asOfDate)
    .where(sql`${table.accountKey} IS NULL`),
  uniqueIndex("imports_p2_account_file_source_as_of_unique")
    .on(table.accountKey, table.scopeKey, table.fileHash, table.sourceKind, table.asOfDate)
    .where(sql`${table.accountKey} IS NOT NULL AND ${table.scopeKey} IS NOT NULL`),
  index("imports_p2_logical_import_key_idx").on(table.logicalImportKey),
  uniqueIndex("imports_p2_logical_content_unique")
    .on(table.logicalImportKey, table.canonicalContentHash)
    .where(sql`${table.logicalImportKey} IS NOT NULL AND ${table.canonicalContentHash} IS NOT NULL`),
  index("imports_source_kind_status_as_of_idx").on(table.sourceKind, table.status, table.asOfDate),
  index("imports_current_scope_idx").on(table.status, table.sourceRole, table.coverageType, table.accountKey, table.scopeKey, table.asOfDate),
  index("imports_supersedes_import_id_idx").on(table.supersedesImportId),
]);

export const accountSourceMappings = sqliteTable("account_source_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mappingKey: text("mapping_key").notNull(),
  sourceKind: text("source_kind").notNull(),
  accountKey: text("account_key").notNull(),
  scopeKey: text("scope_key").notNull(),
  status: text("status").notNull().default("pending"),
  approvedBy: text("approved_by"),
  approvedAt: text("approved_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("account_source_mappings_key_source_unique").on(table.mappingKey, table.sourceKind),
  index("account_source_mappings_status_idx").on(table.status),
  index("account_source_mappings_account_scope_idx").on(table.accountKey, table.scopeKey),
]);

export const assets = sqliteTable("assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  assetClass: text("asset_class").notNull(),
  canonicalName: text("canonical_name").notNull(),
  currency: text("currency"),
  shareClass: text("share_class"),
  distributionMode: text("distribution_mode"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("assets_identity_lookup_idx").on(table.assetClass, table.canonicalName, table.currency, table.shareClass, table.distributionMode),
]);

export const assetCodes = sqliteTable("asset_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  assetId: integer("asset_id").notNull().references(() => assets.id),
  codeType: text("code_type").notNull(),
  normalizedCode: text("normalized_code").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("asset_codes_type_code_unique").on(table.codeType, table.normalizedCode),
  index("asset_codes_asset_id_idx").on(table.assetId),
]);

export const assetAliasMappings = sqliteTable("asset_alias_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  assetId: integer("asset_id").notNull().references(() => assets.id),
  assetClass: text("asset_class").notNull(),
  normalizedAlias: text("normalized_alias").notNull(),
  approvedBy: text("approved_by").notNull(),
  approvedAt: text("approved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("asset_alias_class_alias_unique").on(table.assetClass, table.normalizedAlias),
  index("asset_alias_asset_id_idx").on(table.assetId),
]);

export const positions = sqliteTable("positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importId: integer("import_id").references(() => imports.id),
  assetId: integer("asset_id").references(() => assets.id),
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
  riskRewardLevel: text("risk_reward_level"),
  sourceKind: text("source_kind").notNull(),
  rawJson: text("raw_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("positions_asset_type_idx").on(table.assetType),
  index("positions_import_id_idx").on(table.importId),
  index("positions_asset_id_idx").on(table.assetId),
  index("positions_asset_category_idx").on(table.assetCategory),
  index("positions_last_purchase_date_idx").on(table.lastPurchaseDate),
  index("positions_risk_reward_level_idx").on(table.riskRewardLevel),
]);

export const importQuarantine = sqliteTable("import_quarantine", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importId: integer("import_id").references(() => imports.id),
  kind: text("kind").notNull(),
  reasonCode: text("reason_code").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("import_quarantine_status_reason_idx").on(table.status, table.reasonCode),
  index("import_quarantine_import_id_idx").on(table.importId),
]);

export const cutoverManagedScopes = sqliteTable("cutover_managed_scopes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountKey: text("account_key").notNull(),
  scopeKey: text("scope_key").notNull(),
  status: text("status").notNull().default("shadow"),
  ownerApproved: integer("owner_approved").notNull().default(0),
  approvedAt: text("approved_at"),
  note: text("note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("cutover_managed_scopes_account_scope_unique").on(table.accountKey, table.scopeKey),
  index("cutover_managed_scopes_status_approved_idx").on(table.status, table.ownerApproved),
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

export const portfolioSnapshotImports = sqliteTable("portfolio_snapshot_imports", {
  snapshotId: integer("snapshot_id").notNull().references(() => portfolioSnapshots.id),
  importId: integer("import_id").notNull().references(() => imports.id),
}, (table) => [
  primaryKey({ columns: [table.snapshotId, table.importId] }),
  index("portfolio_snapshot_imports_import_id_idx").on(table.importId),
]);
