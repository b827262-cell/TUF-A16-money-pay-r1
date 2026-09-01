/**
 * Read-only view of the local SQLite (D1 preview / wrangler state) database.
 *
 * Every field name here is taken from db/schema.ts and the committed migrations, and the
 * as-of queries below are copies of lib/portfolio.ts so the plan can predict what the deployed
 * site will answer. Plain node cannot import the .ts helpers, so the equivalence is pinned by
 * tests/sites-data-sync.test.mjs instead of by a shared import.
 */
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const IMPORT_ROW_CAP = 1000;
export const OCR_IMAGE_BYTE_CAP = 10 * 1024 * 1024;

const NUMERIC_COLUMNS = [
  "units", "avgCost", "marketPrice", "costBasisTwd", "marketValueTwd",
  "pnlTwd", "returnPct", "dividendTwd",
];

const REQUIRED_COLUMNS = {
  imports: ["id", "filename", "file_hash", "source_kind", "row_count", "as_of_date", "status", "parser_version", "created_at"],
  positions: [
    "id", "import_id", "asset_code", "asset_name", "asset_type", "currency", "units", "avg_cost",
    "market_price", "cost_basis_twd", "market_value_twd", "pnl_twd", "return_pct", "dividend_twd",
    "valuation_date", "risk_reward_level", "source_kind", "raw_json", "created_at",
  ],
  ocr_documents: ["id", "object_key", "filename", "doc_type", "raw_text", "extracted_json", "confidence", "review_status", "created_at"],
  portfolio_snapshots: ["id", "snapshot_date", "position_count", "cost_basis_twd", "market_value_twd", "pnl_twd", "dividend_twd", "created_at"],
};

const MIGRATION_FOR_TABLE = {
  imports: "0000_sudden_punisher.sql",
  ocr_documents: "0000_sudden_punisher.sql",
  positions: "0004_fund_risk_reward.sql",
  portfolio_snapshots: "0001_living_miss_america.sql",
};

const LATE_IMPORT_COLUMNS = { as_of_date: "0002_as_of_import_status.sql", status: "0002_as_of_import_status.sql", parser_version: "0002_as_of_import_status.sql" };

export class SyncError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    if (details) this.details = details;
  }
}

export function openSourceDatabase(path) {
  const absolute = resolve(path);
  let db;
  try {
    db = new DatabaseSync(absolute, { readOnly: true });
  } catch (error) {
    throw new SyncError("SOURCE_UNREADABLE", `無法唯讀開啟來源資料庫：${error instanceof Error ? error.message : String(error)}`, { path: absolute });
  }
  const problems = inspectSchema(db);
  if (problems.length) {
    db.close();
    throw new SyncError("SOURCE_SCHEMA_MISMATCH", `來源資料庫結構不符合 drizzle migration：\n  - ${problems.join("\n  - ")}`, { path: absolute });
  }
  return db;
}

export function inspectSchema(db) {
  const problems = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(tableColumns(db, table));
    if (!present.size) {
      problems.push(`缺少資料表 ${table}（需要 drizzle/${MIGRATION_FOR_TABLE[table]}）`);
      continue;
    }
    for (const column of columns) {
      if (!present.has(column)) {
        const migration = LATE_IMPORT_COLUMNS[column] ?? MIGRATION_FOR_TABLE[table];
        problems.push(`${table} 缺少欄位 ${column}（需要 drizzle/${migration}）`);
      }
    }
  }
  return problems;
}

function tableColumns(db, table) {
  try {
    return db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((row) => row.name);
  } catch {
    return [];
  }
}

const IMPORT_SELECT = `SELECT id, filename, file_hash AS fileHash, source_kind AS sourceKind, row_count AS rowCount,
        as_of_date AS asOfDate, status, parser_version AS parserVersion, created_at AS createdAt
      FROM imports`;

const POSITION_SELECT = `SELECT id, import_id AS importId, asset_code AS assetCode, asset_name AS assetName,
        asset_type AS assetType, currency, units, avg_cost AS avgCost, market_price AS marketPrice,
        cost_basis_twd AS costBasisTwd, market_value_twd AS marketValueTwd, pnl_twd AS pnlTwd,
        return_pct AS returnPct, dividend_twd AS dividendTwd, valuation_date AS valuationDate,
        risk_reward_level AS riskRewardLevel, source_kind AS sourceKind, raw_json AS rawJson
      FROM positions WHERE import_id = ? ORDER BY id ASC`;

export function readAppliedImports(db) {
  // Oldest statistics date first, so a replay lands history in the order the site saw it.
  const applied = db.prepare(`${IMPORT_SELECT} WHERE status = 'applied' ORDER BY as_of_date ASC, id ASC`).all();
  return applied.map((record) => ({ ...record, positions: db.prepare(POSITION_SELECT).all(record.id) }));
}

/** Positions that no applied batch owns: never sent, but always reported so nothing vanishes silently. */
export function readUnsyncablePositionCounts(db) {
  return {
    pendingBatch: Number(db.prepare(`SELECT COUNT(*) AS n FROM positions p JOIN imports i ON i.id = p.import_id WHERE i.status <> 'applied'`).get().n),
    noBatch: Number(db.prepare(`SELECT COUNT(*) AS n FROM positions WHERE import_id IS NULL OR import_id NOT IN (SELECT id FROM imports)`).get().n),
  };
}

export function readOcrDocuments(db) {
  return db.prepare(`SELECT id, object_key AS objectKey, filename, doc_type AS docType, raw_text AS rawText,
        extracted_json AS extractedJson, confidence, review_status AS reviewStatus, created_at AS createdAt
      FROM ocr_documents ORDER BY created_at ASC, id ASC`).all();
}

export function readPortfolioSnapshots(db) {
  return db.prepare(`SELECT id, snapshot_date AS snapshotDate, position_count AS positionCount,
        cost_basis_twd AS costBasisTwd, market_value_twd AS marketValueTwd, pnl_twd AS pnlTwd,
        dividend_twd AS dividendTwd, created_at AS createdAt
      FROM portfolio_snapshots ORDER BY snapshot_date ASC`).all();
}

/**
 * lib/portfolio.ts:109-147 verbatim (SQLite window function supported by both node:sqlite and D1).
 * Only the first applied batch per source_kind is current for a date, so expectations must be
 * derived the same way the deployed site derives its answer.
 */
export function expectedPortfolioAsOf(db, asOfDate) {
  const params = asOfDate ? [asOfDate] : [];
  const ranked = `SELECT imports.*, ROW_NUMBER() OVER (PARTITION BY source_kind ORDER BY as_of_date DESC, id DESC) AS rank_no
      FROM imports
      WHERE status = 'applied' AND as_of_date IS NOT NULL${asOfDate ? " AND as_of_date <= ?" : ""}`;
  const importsUsed = db
    .prepare(`SELECT id, filename, source_kind AS sourceKind, row_count AS rowCount, as_of_date AS asOfDate,
        status, parser_version AS parserVersion, created_at AS createdAt
      FROM (${ranked}) WHERE rank_no = 1 ORDER BY source_kind`)
    .all(...params);
  const positions = db
    .prepare(`SELECT p.id AS id, p.import_id AS importId, p.asset_code AS assetCode, p.asset_name AS assetName,
        p.asset_type AS assetType, p.currency AS currency, p.units AS units, p.avg_cost AS avgCost,
        p.market_price AS marketPrice, p.cost_basis_twd AS costBasisTwd, p.market_value_twd AS marketValueTwd,
        p.pnl_twd AS pnlTwd, p.return_pct AS returnPct, p.dividend_twd AS dividendTwd,
        p.valuation_date AS valuationDate, p.source_kind AS sourceKind
      FROM positions p
      JOIN (SELECT id FROM (${ranked}) WHERE rank_no = 1) used ON used.id = p.import_id
      ORDER BY p.asset_type, p.asset_name`)
    .all(...params);
  return { asOfDate, dataAsOf: latestDate(importsUsed), totals: summarize(positions), importsUsed };
}

function latestDate(importsUsed) {
  return importsUsed.reduce((latest, item) => (item.asOfDate && (!latest || item.asOfDate > latest) ? item.asOfDate : latest), null);
}

/** lib/portfolio.ts:180 summarizePositions: same reduce order, so totals land on the same float. */
function summarize(positions) {
  return positions.reduce((totals, position) => ({
    positionCount: totals.positionCount + 1,
    costBasisTwd: totals.costBasisTwd + position.costBasisTwd,
    marketValueTwd: totals.marketValueTwd + position.marketValueTwd,
    pnlTwd: totals.pnlTwd + position.pnlTwd,
    dividendTwd: totals.dividendTwd + position.dividendTwd,
  }), { positionCount: 0, costBasisTwd: 0, marketValueTwd: 0, pnlTwd: 0, dividendTwd: 0 });
}

/**
 * positions row -> the CanonicalRow that app/api/import/route.ts:4-9 binds.
 * Nulls stay null and numbers stay numbers: the route only applies `?? default`, so an exact
 * pass-through is what makes the deployed row byte-identical to the local one.
 */
export function mapPositionToCanonicalRow(position) {
  const reasons = [];
  if (!isNonEmptyString(position.assetName)) reasons.push(`asset_name 為空（id=${position.id}）`);
  if (!isNonEmptyString(position.assetType)) reasons.push(`asset_type 為空（id=${position.id}）`);
  if (!isNonEmptyString(position.currency)) reasons.push(`currency 為空（id=${position.id}）`);
  if (position.assetCode !== null && position.assetCode !== undefined && typeof position.assetCode !== "string") {
    reasons.push(`asset_code 不是文字（id=${position.id}）`);
  }
  if (position.valuationDate !== null && position.valuationDate !== undefined && typeof position.valuationDate !== "string") {
    reasons.push(`valuation_date 不是文字（id=${position.id}）`);
  }
  for (const column of NUMERIC_COLUMNS) {
    if (typeof position[column] !== "number" || !Number.isFinite(position[column])) {
      reasons.push(`${column} 不是有限數值（id=${position.id}，值=${JSON.stringify(position[column])}）`);
    }
  }

  let raw;
  try {
    const parsed = JSON.parse(position.rawJson ?? "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      reasons.push(`raw_json 不是 JSON 物件（id=${position.id}）`);
    } else {
      raw = parsed;
    }
  } catch {
    reasons.push(`raw_json 無法解析（id=${position.id}）`);
  }

  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    row: {
      assetCode: position.assetCode ?? null,
      assetName: position.assetName,
      assetType: position.assetType,
      currency: position.currency,
      units: position.units,
      avgCost: position.avgCost,
      marketPrice: position.marketPrice,
      costBasisTwd: position.costBasisTwd,
      marketValueTwd: position.marketValueTwd,
      pnlTwd: position.pnlTwd,
      returnPct: position.returnPct,
      dividendTwd: position.dividendTwd,
      valuationDate: position.valuationDate ?? null,
      raw,
    },
  };
}

export function summarizeRows(rows) {
  return rows.reduce((totals, row) => ({
    positionCount: totals.positionCount + 1,
    costBasisTwd: totals.costBasisTwd + row.costBasisTwd,
    marketValueTwd: totals.marketValueTwd + row.marketValueTwd,
    pnlTwd: totals.pnlTwd + row.pnlTwd,
    dividendTwd: totals.dividendTwd + row.dividendTwd,
  }), { positionCount: 0, costBasisTwd: 0, marketValueTwd: 0, pnlTwd: 0, dividendTwd: 0 });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `object_key` is data, not a trusted path: candidates that escape `imageDir` are dropped. */
export function ocrImageCandidates(document, imageDir) {
  if (!imageDir) return [];
  const base = resolve(imageDir);
  const key = typeof document.objectKey === "string" ? document.objectKey.replace(/^\/+/, "") : "";
  const names = [key, key ? key.split("/").pop() : "", document.filename ?? ""].filter(Boolean);
  const paths = new Set();
  for (const name of names) {
    const candidate = resolve(base, name);
    if (candidate === base || candidate.startsWith(base + "/")) paths.add(candidate);
  }
  return [...paths];
}
