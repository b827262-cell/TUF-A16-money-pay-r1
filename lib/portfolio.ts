import type { AssetCategory, IndustryTheme, InvestRegion, InvestStyle, MarketCapTier, PurchaseDateBasis } from "@/lib/position-classification";
import type { RiskRewardLevel } from "@/lib/fund-risk-reward";

export const PARSER_VERSION = 1;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ImportStatus = "pending" | "applied";

/** Smallest slice of the D1 API these helpers need, so tests can run them on plain SQLite. */
export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface SqlDatabase {
  prepare(query: string): PreparedStatement;
}

export type ImportRecord = {
  id: number;
  filename: string;
  sourceKind: string;
  rowCount: number;
  asOfDate: string | null;
  status: ImportStatus;
  parserVersion: number;
  createdAt: string;
};

export type PositionRecord = {
  id: number;
  importId: number | null;
  assetCode: string | null;
  assetName: string;
  assetType: string;
  currency: string;
  units: number;
  avgCost: number;
  marketPrice: number;
  costBasisTwd: number;
  marketValueTwd: number;
  pnlTwd: number;
  returnPct: number;
  dividendTwd: number;
  valuationDate: string | null;
  lastPurchaseDate: string | null;
  purchaseDateBasis: PurchaseDateBasis;
  assetCategory: AssetCategory | null;
  investRegion: InvestRegion | null;
  marketCapTier: MarketCapTier | null;
  investStyle: InvestStyle | null;
  industryTheme: IndustryTheme | null;
  riskRewardLevel: RiskRewardLevel | null;
  sourceKind: string;
};

export type PortfolioTotals = {
  positionCount: number;
  costBasisTwd: number;
  marketValueTwd: number;
  pnlTwd: number;
  dividendTwd: number;
};

export type PortfolioAsOf = {
  asOfDate: string | null;
  dataAsOf: string | null;
  totals: PortfolioTotals;
  positions: PositionRecord[];
  importsUsed: ImportRecord[];
};

export type ComparisonMetric = {
  key: keyof Omit<PortfolioTotals, "positionCount">;
  label: string;
  from: number;
  to: number;
  delta: number;
};

export type PortfolioComparison = {
  from: PortfolioAsOf;
  to: PortfolioAsOf;
  metrics: ComparisonMetric[];
};

export const PACKAGE_COVERAGE_ANCHOR_SOURCE_KIND = "monthly_statement_video";

export class PortfolioQueryError extends Error {}

/** Rejects anything that is not a real, zero-padded calendar date; the as-of filter compares these as text. */
export function parseAsOfDate(value: unknown, options: { required: true }): string;
export function parseAsOfDate(value: unknown, options?: { required?: boolean }): string | null;
export function parseAsOfDate(value: unknown, { required = false }: { required?: boolean } = {}): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new PortfolioQueryError("請提供 YYYY-MM-DD 格式的統計日期");
    return null;
  }
  const text = String(value).trim();
  if (!ISO_DATE.test(text)) throw new PortfolioQueryError("統計日期格式必須是 YYYY-MM-DD");
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new PortfolioQueryError(`統計日期不存在：${text}`);
  }
  return text;
}

export function todayInTaipei(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const IMPORT_COLUMNS = `id, filename, source_kind AS sourceKind, row_count AS rowCount,
        as_of_date AS asOfDate, status, parser_version AS parserVersion, created_at AS createdAt`;

/**
 * Ranked per source_kind so callers can pick the one import that represents a given date.
 * Statistics date wins over id: a file uploaded later that describes an earlier date must not
 * shadow the newer snapshot of the same source.
 */
function rankedImportsQuery(asOfDate: string | null, minimumAsOfDate: string | null = null) {
  const conditions = ["status = 'applied'", "as_of_date IS NOT NULL"];
  const params: string[] = [];
  if (minimumAsOfDate) {
    conditions.push("as_of_date >= ?");
    params.push(minimumAsOfDate);
  }
  if (asOfDate) {
    conditions.push("as_of_date <= ?");
    params.push(asOfDate);
  }
  return {
    sql: `SELECT imports.*, ROW_NUMBER() OVER (PARTITION BY source_kind ORDER BY as_of_date DESC, id DESC) AS rank_no
      FROM imports
      WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

function pickFirstPerKind(columns: string, asOfDate: string | null, minimumAsOfDate: string | null = null, orderBy = "") {
  const { sql, params } = rankedImportsQuery(asOfDate, minimumAsOfDate);
  return { sql: `SELECT ${columns} FROM (${sql}) WHERE rank_no = 1${orderBy}`, params };
}

function currentImportIdsQuery(asOfDate: string | null, minimumAsOfDate: string | null = null) {
  return pickFirstPerKind("id", asOfDate, minimumAsOfDate);
}

function currentImportsQuery(asOfDate: string | null, minimumAsOfDate: string | null = null) {
  return pickFirstPerKind(IMPORT_COLUMNS, asOfDate, minimumAsOfDate, " ORDER BY source_kind");
}

const POSITION_COLUMNS = `p.id AS id, p.import_id AS importId, p.asset_code AS assetCode, p.asset_name AS assetName,
  p.asset_type AS assetType, p.currency AS currency, p.units AS units, p.avg_cost AS avgCost,
  p.market_price AS marketPrice, p.cost_basis_twd AS costBasisTwd, p.market_value_twd AS marketValueTwd,
  p.pnl_twd AS pnlTwd, p.return_pct AS returnPct, p.dividend_twd AS dividendTwd,
  p.valuation_date AS valuationDate, p.last_purchase_date AS lastPurchaseDate, p.purchase_date_basis AS purchaseDateBasis,
  p.asset_category AS assetCategory, p.invest_region AS investRegion, p.market_cap_tier AS marketCapTier,
  p.invest_style AS investStyle, p.industry_theme AS industryTheme, p.risk_reward_level AS riskRewardLevel, p.source_kind AS sourceKind,
  p.raw_json AS rawJson`;

type StoredPositionRecord = PositionRecord & { rawJson?: string | null };

function parseRawNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text.replace(/[,%+\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRawRecord(rawJson: string | null | undefined): Record<string, unknown> {
  if (!rawJson) return {};
  try {
    const parsed = JSON.parse(rawJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Some handoff sources expose value and return but omit cost. Recover only what the
 * source itself makes calculable; never estimate a cost from a name, category, or RR.
 */
function normalizeStoredPosition(position: StoredPositionRecord, options: { keepRawJson?: boolean } = {}): PositionRecord & { rawJson?: string | null } {
  const raw = parseRawRecord(position.rawJson);
  const rawNumber = (key: string) => parseRawNumber(raw[key]);
  const units = position.units !== 0 ? position.units : rawNumber("數量") ?? rawNumber("可用數量") ?? 0;
  const avgCost = position.avgCost !== 0 ? position.avgCost : rawNumber("均價_平均申購淨值") ?? 0;
  const marketPrice = position.marketPrice !== 0 ? position.marketPrice : rawNumber("市價_最新淨值") ?? 0;
  let costBasisTwd = position.costBasisTwd;
  let marketValueTwd = position.marketValueTwd;

  if (costBasisTwd === 0) {
    const explicitCost = rawNumber("成本");
    if (explicitCost !== null) {
      costBasisTwd = explicitCost;
    } else {
      const sourceValue = marketValueTwd !== 0 ? marketValueTwd : rawNumber("市值");
      // For a total-return source, cost = value - ex-dividend P&L. Falling back to
      // the plain P&L is safe for rows that do not expose a separate return field.
      const sourcePnl = rawNumber("不含息損益") ?? rawNumber("損益");
      if (sourceValue !== null && sourcePnl !== null) costBasisTwd = sourceValue - sourcePnl;
      else if (units !== 0 && avgCost !== 0) costBasisTwd = units * avgCost;
    }
  }

  if (marketValueTwd === 0) {
    const explicitValue = rawNumber("市值");
    if (explicitValue !== null) marketValueTwd = explicitValue;
    else if (units !== 0 && marketPrice !== 0) marketValueTwd = units * marketPrice;
  }

  const publicPosition = { ...position };
  delete publicPosition.rawJson;
  const normalized = { ...publicPosition, costBasisTwd, marketValueTwd };
  return options.keepRawJson ? { ...normalized, rawJson: position.rawJson ?? "{}" } : normalized;
}

/** Positions of the imports that are current as of `asOfDate`; every other batch is history only. */
function currentPositionsQuery(asOfDate: string | null, minimumAsOfDate: string | null = null) {
  const { sql, params } = currentImportIdsQuery(asOfDate, minimumAsOfDate);
  return {
    sql: `SELECT ${POSITION_COLUMNS}
      FROM positions p
      JOIN (${sql}) used ON used.id = p.import_id
      ORDER BY p.asset_type, p.asset_name`,
    params,
  };
}

export async function listCurrentImports(db: SqlDatabase, asOfDate: string | null, minimumAsOfDate: string | null = null): Promise<ImportRecord[]> {
  const query = currentImportsQuery(asOfDate, minimumAsOfDate);
  const result = await db.prepare(query.sql).bind(...query.params).all<ImportRecord>();
  return result.results ?? [];
}

export async function listCurrentPositions(db: SqlDatabase, asOfDate: string | null, minimumAsOfDate: string | null = null): Promise<PositionRecord[]> {
  const query = currentPositionsQuery(asOfDate, minimumAsOfDate);
  const result = await db.prepare(query.sql).bind(...query.params).all<StoredPositionRecord>();
  return (result.results ?? []).map(normalizeStoredPosition);
}

export async function listImportHistory(db: SqlDatabase, limit = 20): Promise<ImportRecord[]> {
  const result = await db.prepare(`SELECT ${IMPORT_COLUMNS} FROM imports ORDER BY created_at DESC, id DESC LIMIT ?`).bind(limit).all<ImportRecord>();
  return result.results ?? [];
}

export type ImportMatch = { id: number; status: ImportStatus };

/** Idempotency key is the bytes plus the source plus the date they describe: the same file on another date is a new batch. */
export async function findImportByContent(db: SqlDatabase, { fileHash, sourceKind, asOfDate }: { fileHash: string; sourceKind: string; asOfDate: string }): Promise<ImportMatch | null> {
  return db.prepare(`SELECT id, status FROM imports WHERE file_hash = ? AND source_kind = ? AND as_of_date = ? LIMIT 1`)
    .bind(fileHash, sourceKind, asOfDate).first<ImportMatch>();
}

/** Every date the portfolio can be replayed for; listImportHistory is capped at recent batches and cannot be the source. */
export async function listAppliedDates(db: SqlDatabase, limit = 365): Promise<string[]> {
  const result = await db.prepare(`SELECT DISTINCT as_of_date AS asOfDate FROM imports WHERE status = 'applied' AND as_of_date IS NOT NULL ORDER BY asOfDate DESC LIMIT ?`).bind(limit).all<{ asOfDate: string }>();
  return (result.results ?? []).map((row) => row.asOfDate);
}

export function summarizePositions(positions: PositionRecord[]): PortfolioTotals {
  return positions.reduce<PortfolioTotals>((totals, position) => ({
    positionCount: totals.positionCount + 1,
    costBasisTwd: totals.costBasisTwd + position.costBasisTwd,
    marketValueTwd: totals.marketValueTwd + position.marketValueTwd,
    pnlTwd: totals.pnlTwd + position.pnlTwd,
    dividendTwd: totals.dividendTwd + position.dividendTwd,
  }), { positionCount: 0, costBasisTwd: 0, marketValueTwd: 0, pnlTwd: 0, dividendTwd: 0 });
}

export async function getPortfolioAsOf(db: SqlDatabase, asOfDate: string | null, options: { minimumAsOfDate?: string | null } = {}): Promise<PortfolioAsOf> {
  const minimumAsOfDate = options.minimumAsOfDate ?? null;
  const [importsUsed, positions] = await Promise.all([
    listCurrentImports(db, asOfDate, minimumAsOfDate),
    listCurrentPositions(db, asOfDate, minimumAsOfDate),
  ]);
  const dataAsOf = importsUsed.reduce<string | null>((latest, item) => {
    if (!item.asOfDate) return latest;
    return !latest || item.asOfDate > latest ? item.asOfDate : latest;
  }, null);
  return { asOfDate, dataAsOf, totals: summarizePositions(positions), positions, importsUsed };
}

/**
 * Finds the beginning of the audited handoff window. The anchor source is unique to
 * this handoff, while legacy production batches remain available outside the window.
 */
export async function findPackageCoverageStartDate(db: SqlDatabase): Promise<string | null> {
  const row = await db.prepare(`SELECT MIN(as_of_date) AS asOfDate
    FROM imports
    WHERE status = 'applied' AND source_kind = ? AND as_of_date IS NOT NULL`)
    .bind(PACKAGE_COVERAGE_ANCHOR_SOURCE_KIND)
    .first<{ asOfDate: string | null }>();
  return row?.asOfDate ?? null;
}

export async function getPackageCoverageAsOf(db: SqlDatabase, asOfDate: string): Promise<PortfolioAsOf> {
  const coverageStartDate = await findPackageCoverageStartDate(db);
  if (!coverageStartDate) throw new PortfolioQueryError("尚無可辨識的交付包覆蓋資料");
  return getPortfolioAsOf(db, asOfDate, { minimumAsOfDate: coverageStartDate });
}

const COMPARISON_LABELS: Array<{ key: ComparisonMetric["key"]; label: string }> = [
  { key: "costBasisTwd", label: "總投資成本" },
  { key: "marketValueTwd", label: "參考市值" },
  { key: "pnlTwd", label: "未實現損益" },
  { key: "dividendTwd", label: "累計配息" },
];

export async function comparePortfolioAsOf(db: SqlDatabase, fromDate: string, toDate: string): Promise<PortfolioComparison> {
  const [from, to] = await Promise.all([getPortfolioAsOf(db, fromDate), getPortfolioAsOf(db, toDate)]);
  return {
    from,
    to,
    metrics: COMPARISON_LABELS.map(({ key, label }) => ({
      key,
      label,
      from: from.totals[key],
      to: to.totals[key],
      delta: to.totals[key] - from.totals[key],
    })),
  };
}

export async function comparePackageCoverageAsOf(db: SqlDatabase, fromDate: string, toDate: string): Promise<PortfolioComparison> {
  const [from, to] = await Promise.all([getPackageCoverageAsOf(db, fromDate), getPackageCoverageAsOf(db, toDate)]);
  return {
    from,
    to,
    metrics: COMPARISON_LABELS.map(({ key, label }) => ({
      key,
      label,
      from: from.totals[key],
      to: to.totals[key],
      delta: to.totals[key] - from.totals[key],
    })),
  };
}
