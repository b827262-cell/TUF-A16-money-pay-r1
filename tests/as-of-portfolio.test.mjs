import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true },
});

after(async () => {
  await vite.close();
});

const { comparePackageCoverageAsOf, comparePortfolioAsOf, findImportByContent, getPackageCoverageAsOf, getPortfolioAsOf, listAppliedDates } = await vite.ssrLoadModule("/lib/portfolio.ts");

const HASH = "f".repeat(64);

/** Mirrors db/schema.ts closely enough for the as-of queries: only imports and positions are read. */
function openDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      as_of_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      parser_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX imports_file_hash_source_as_of_unique ON imports(file_hash, source_kind, as_of_date);
    CREATE TABLE positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER REFERENCES imports(id),
      asset_code TEXT,
      asset_name TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'TWD',
      units REAL NOT NULL DEFAULT 0,
      avg_cost REAL NOT NULL DEFAULT 0,
      market_price REAL NOT NULL DEFAULT 0,
      cost_basis_twd REAL NOT NULL DEFAULT 0,
      market_value_twd REAL NOT NULL DEFAULT 0,
      pnl_twd REAL NOT NULL DEFAULT 0,
      return_pct REAL NOT NULL DEFAULT 0,
      dividend_twd REAL NOT NULL DEFAULT 0,
      valuation_date TEXT,
      last_purchase_date TEXT,
      purchase_date_basis TEXT NOT NULL DEFAULT 'unknown',
      asset_category TEXT,
      invest_region TEXT,
      market_cap_tier TEXT,
      invest_style TEXT,
      industry_theme TEXT,
      risk_reward_level TEXT,
      source_kind TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

/** The helpers only need D1's prepare/bind/all/first shape, so node:sqlite can stand in for env.DB. */
function asD1(sqlite) {
  return {
    prepare(query) {
      const statement = sqlite.prepare(query);
      const wrap = (values) => ({
        all: async () => ({ results: statement.all(...values) }),
        first: async () => statement.all(...values)[0] ?? null,
      });
      return { bind: (...values) => wrap(values), all: () => wrap([]).all, first: () => wrap([]).first };
    },
  };
}

function addBatch(sqlite, { filename, fileHash = HASH, sourceKind, asOfDate, status = "applied", positions }) {
  const inserted = sqlite
    .prepare("INSERT INTO imports (filename, file_hash, source_kind, row_count, as_of_date, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(filename, fileHash, sourceKind, positions.length, asOfDate, status);
  const importId = Number(inserted.lastInsertRowid);
  const statement = sqlite.prepare(`INSERT INTO positions
    (import_id, asset_name, asset_type, currency, units, avg_cost, market_price, cost_basis_twd, market_value_twd, pnl_twd, return_pct, dividend_twd, source_kind, raw_json)
    VALUES (?, ?, ?, 'TWD', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
  for (const position of positions) {
    statement.run(importId, position.assetName, position.assetType ?? "證券", position.units ?? 0, position.avgCost ?? 0, position.marketPrice ?? 0, position.costBasisTwd ?? 0, position.marketValueTwd ?? 0, position.pnlTwd ?? 0, position.dividendTwd ?? 0, sourceKind, JSON.stringify(position.raw ?? {}));
  }
  return importId;
}

test("replays one source kind per statistics date instead of summing every upload", async () => {
  const sqlite = openDatabase();
  addBatch(sqlite, { filename: "stock-0824.csv", sourceKind: "stock_csv", asOfDate: "2026-08-24", positions: [{ assetName: "中華電", costBasisTwd: 90, marketValueTwd: 100, pnlTwd: 10 }] });
  addBatch(sqlite, { filename: "stock-0831.csv", sourceKind: "stock_csv", asOfDate: "2026-08-31", positions: [{ assetName: "中華電", costBasisTwd: 90, marketValueTwd: 120, pnlTwd: 30 }] });
  const db = asD1(sqlite);

  const before = await getPortfolioAsOf(db, "2026-08-24");
  assert.equal(before.totals.marketValueTwd, 100);
  assert.equal(before.totals.costBasisTwd, 90);
  assert.equal(before.totals.pnlTwd, 10);
  assert.equal(before.totals.positionCount, 1);
  assert.deepEqual(before.importsUsed.map((item) => item.filename), ["stock-0824.csv"]);

  const after = await getPortfolioAsOf(db, "2026-08-31");
  assert.equal(after.totals.marketValueTwd, 120);
  assert.equal(after.totals.positionCount, 1);
  assert.deepEqual(after.importsUsed.map((item) => item.filename), ["stock-0831.csv"]);

  assert.equal((await getPortfolioAsOf(db, null)).totals.marketValueTwd, 120);
  assert.equal((await getPortfolioAsOf(db, "2026-08-23")).totals.marketValueTwd, 0);
});

test("merges the newest applied batch of every source kind", async () => {
  const sqlite = openDatabase();
  addBatch(sqlite, { filename: "stock-0824.csv", sourceKind: "stock_csv", asOfDate: "2026-08-24", positions: [{ assetName: "中華電", marketValueTwd: 100 }] });
  addBatch(sqlite, { filename: "fund-0824.csv", sourceKind: "fund_csv", asOfDate: "2026-08-24", positions: [{ assetName: "0050 母基金", assetType: "基金", marketValueTwd: 60, dividendTwd: 5 }] });
  addBatch(sqlite, { filename: "stock-0831.csv", sourceKind: "stock_csv", asOfDate: "2026-08-31", positions: [{ assetName: "中華電", marketValueTwd: 120 }] });
  addBatch(sqlite, { filename: "fund-0831.csv", sourceKind: "fund_csv", asOfDate: "2026-08-31", positions: [{ assetName: "0050 母基金", assetType: "基金", marketValueTwd: 80, dividendTwd: 9 }] });
  addBatch(sqlite, { filename: "stock-0907-draft.csv", sourceKind: "stock_csv", asOfDate: "2026-09-07", status: "pending", positions: [{ assetName: "中華電", marketValueTwd: 999 }] });
  const db = asD1(sqlite);

  const on24 = await getPortfolioAsOf(db, "2026-08-24");
  assert.equal(on24.totals.marketValueTwd, 160);
  assert.equal(on24.totals.dividendTwd, 5);
  assert.equal(on24.totals.positionCount, 2);
  assert.deepEqual(on24.importsUsed.map((item) => item.sourceKind), ["fund_csv", "stock_csv"]);
  assert.equal(on24.dataAsOf, "2026-08-24");

  const on31 = await getPortfolioAsOf(db, "2026-08-31");
  assert.equal(on31.totals.marketValueTwd, 200);
  assert.equal(on31.totals.dividendTwd, 9);
  assert.deepEqual(on31.importsUsed.map((item) => item.filename), ["fund-0831.csv", "stock-0831.csv"]);

  // A date with nothing applied yet carries the last known good batch forward, and never the pending draft.
  const later = await getPortfolioAsOf(db, "2026-09-07");
  assert.equal(later.totals.marketValueTwd, 200);
  assert.deepEqual(later.importsUsed.map((item) => item.filename), ["fund-0831.csv", "stock-0831.csv"]);
});

test("reports the money delta between two statistics dates", async () => {
  const sqlite = openDatabase();
  addBatch(sqlite, { filename: "stock-0824.csv", sourceKind: "stock_csv", asOfDate: "2026-08-24", positions: [{ assetName: "中華電", costBasisTwd: 90, marketValueTwd: 100, pnlTwd: 10, dividendTwd: 2 }] });
  addBatch(sqlite, { filename: "fund-0824.csv", sourceKind: "fund_csv", asOfDate: "2026-08-24", positions: [{ assetName: "0050 母基金", assetType: "基金", costBasisTwd: 50, marketValueTwd: 60, pnlTwd: 10, dividendTwd: 3 }] });
  addBatch(sqlite, { filename: "stock-0831.csv", sourceKind: "stock_csv", asOfDate: "2026-08-31", positions: [{ assetName: "中華電", costBasisTwd: 90, marketValueTwd: 120, pnlTwd: 30, dividendTwd: 2 }] });
  addBatch(sqlite, { filename: "fund-0831.csv", sourceKind: "fund_csv", asOfDate: "2026-08-31", positions: [{ assetName: "0050 母基金", assetType: "基金", costBasisTwd: 55, marketValueTwd: 80, pnlTwd: 25, dividendTwd: 3 }] });

  const comparison = await comparePortfolioAsOf(asD1(sqlite), "2026-08-24", "2026-08-31");
  const byKey = Object.fromEntries(comparison.metrics.map((metric) => [metric.key, metric]));

  assert.deepEqual(comparison.metrics.map((metric) => metric.key), ["costBasisTwd", "marketValueTwd", "pnlTwd", "dividendTwd"]);
  assert.deepEqual({ from: byKey.costBasisTwd.from, to: byKey.costBasisTwd.to, delta: byKey.costBasisTwd.delta }, { from: 140, to: 145, delta: 5 });
  assert.deepEqual({ from: byKey.marketValueTwd.from, to: byKey.marketValueTwd.to, delta: byKey.marketValueTwd.delta }, { from: 160, to: 200, delta: 40 });
  assert.deepEqual({ from: byKey.pnlTwd.from, to: byKey.pnlTwd.to, delta: byKey.pnlTwd.delta }, { from: 20, to: 55, delta: 35 });
  assert.deepEqual({ from: byKey.dividendTwd.from, to: byKey.dividendTwd.to, delta: byKey.dividendTwd.delta }, { from: 5, to: 5, delta: 0 });
  assert.equal(comparison.from.totals.positionCount, 2);
  assert.equal(comparison.to.totals.positionCount, 2);
  assert.deepEqual(comparison.from.importsUsed.map((item) => item.asOfDate), ["2026-08-24", "2026-08-24"]);
});

test("recovers omitted source costs without guessing from labels", async () => {
  const sqlite = openDatabase();
  addBatch(sqlite, {
    filename: "integrated-0904.csv",
    sourceKind: "monthly_statement_video",
    asOfDate: "2026-09-04",
    positions: [
      { assetName: "全球平衡基金", assetType: "基金", marketValueTwd: 314070, pnlTwd: 12431, raw: { "市值": "314070", "損益": "12431" } },
      { assetName: "貝萊德環球資產配置基金", assetType: "基金", marketValueTwd: 112553, pnlTwd: 510, raw: { "市值": "112553", "含息損益": "510", "不含息損益": "-952" } },
      { assetName: "元大台灣50反1", assetType: "證券", units: 4746, avgCost: 11.11, marketPrice: 9.86, pnlTwd: -6038, raw: { "數量": "4746", "均價_平均申購淨值": "11.11", "市價_最新淨值": "9.86", "損益": "-6038" } },
    ],
  });

  const portfolio = await getPortfolioAsOf(asD1(sqlite), "2026-09-04");
  assert.equal(portfolio.totals.costBasisTwd, 467872.06);
  assert.equal(portfolio.totals.marketValueTwd, 473418.56);
  const yuanDa = portfolio.positions.find((position) => position.assetName === "元大台灣50反1");
  assert.deepEqual({ cost: yuanDa?.costBasisTwd, value: yuanDa?.marketValueTwd }, { cost: 52728.06, value: 46795.56 });
});

test("package coverage excludes legacy production batches while carrying handoff batches forward", async () => {
  const sqlite = openDatabase();
  addBatch(sqlite, { filename: "legacy-stock.csv", sourceKind: "stock_csv", asOfDate: "2026-08-30", positions: [{ assetName: "舊證券", marketValueTwd: 100 }] });
  addBatch(sqlite, { filename: "legacy-fund.csv", sourceKind: "fund_csv", asOfDate: "2026-08-30", positions: [{ assetName: "舊基金", assetType: "基金", marketValueTwd: 200 }] });
  addBatch(sqlite, { filename: "legacy-ocr.csv", sourceKind: "fund_detail_ocr", asOfDate: "2026-08-30", positions: [{ assetName: "舊 OCR", assetType: "基金", marketValueTwd: 300 }] });
  addBatch(sqlite, { filename: "handoff-video.mp4", sourceKind: "monthly_statement_video", asOfDate: "2026-08-31", positions: [{ assetName: "交付基金 A", assetType: "基金", marketValueTwd: 400 }] });
  addBatch(sqlite, { filename: "handoff-ocr.csv", sourceKind: "fund_detail_ocr", asOfDate: "2026-08-31", positions: [{ assetName: "交付基金 B", assetType: "基金", marketValueTwd: 500 }] });
  addBatch(sqlite, { filename: "handoff-stock.csv", sourceKind: "stock_csv", asOfDate: "2026-09-01", positions: [{ assetName: "交付證券", marketValueTwd: 600 }] });
  addBatch(sqlite, { filename: "handoff-fund.csv", sourceKind: "fund_csv", asOfDate: "2026-09-01", positions: [{ assetName: "交付基金 C", assetType: "基金", marketValueTwd: 700 }] });

  const comparison = await comparePackageCoverageAsOf(asD1(sqlite), "2026-08-31", "2026-09-01");
  assert.equal(comparison.from.totals.positionCount, 2);
  assert.equal(comparison.from.totals.marketValueTwd, 900);
  assert.equal(comparison.to.totals.positionCount, 4);
  assert.equal(comparison.to.totals.marketValueTwd, 2200);
  assert.deepEqual(comparison.from.importsUsed.map((item) => item.filename), ["handoff-ocr.csv", "handoff-video.mp4"]);
  assert.deepEqual(comparison.to.importsUsed.map((item) => item.filename), ["handoff-fund.csv", "handoff-ocr.csv", "handoff-video.mp4", "handoff-stock.csv"]);

  const production = await getPortfolioAsOf(asD1(sqlite), "2026-08-31");
  assert.equal(production.totals.marketValueTwd, 1200);
  const packageOn31 = await getPackageCoverageAsOf(asD1(sqlite), "2026-08-31");
  assert.equal(packageOn31.totals.marketValueTwd, 900);
});

test("lists every applied statistics date for the comparison picker", async () => {
  const sqlite = openDatabase();
  addBatch(sqlite, { filename: "stock-0824.csv", sourceKind: "stock_csv", asOfDate: "2026-08-24", positions: [{ assetName: "中華電", marketValueTwd: 100 }] });
  addBatch(sqlite, { filename: "fund-0824.csv", sourceKind: "fund_csv", asOfDate: "2026-08-24", positions: [{ assetName: "0050 母基金", assetType: "基金", marketValueTwd: 60 }] });
  addBatch(sqlite, { filename: "stock-0831.csv", sourceKind: "stock_csv", asOfDate: "2026-08-31", positions: [{ assetName: "中華電", marketValueTwd: 120 }] });
  addBatch(sqlite, { filename: "no-date.csv", sourceKind: "stock_csv", asOfDate: null, positions: [{ assetName: "台積電", marketValueTwd: 7 }] });
  addBatch(sqlite, { filename: "draft.csv", sourceKind: "fund_csv", asOfDate: "2026-09-07", status: "pending", positions: [{ assetName: "0050 母基金", assetType: "基金", marketValueTwd: 3 }] });
  const db = asD1(sqlite);

  assert.deepEqual(await listAppliedDates(db), ["2026-08-31", "2026-08-24"]);
  assert.deepEqual(await listAppliedDates(db, 1), ["2026-08-31"]);
});

test("the same bytes stay one batch per statistics date", async () => {
  const sqlite = openDatabase();
  const on24 = addBatch(sqlite, { filename: "holdings-0824.csv", sourceKind: "stock_csv", asOfDate: "2026-08-24", positions: [{ assetName: "中華電", marketValueTwd: 100 }] });
  const on31 = addBatch(sqlite, { filename: "holdings-0831.csv", sourceKind: "stock_csv", asOfDate: "2026-08-31", positions: [{ assetName: "中華電", marketValueTwd: 100 }] });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imports").get().n, 2);

  assert.throws(
    () => addBatch(sqlite, { filename: "holdings-0824-retry.csv", sourceKind: "stock_csv", asOfDate: "2026-08-24", positions: [{ assetName: "中華電", marketValueTwd: 100 }] }),
    (error) => /UNIQUE constraint failed/.test(error.message)
      && error.message.includes("imports.file_hash")
      && error.message.includes("imports.source_kind")
      && error.message.includes("imports.as_of_date"),
  );

  const db = asD1(sqlite);
  const first = await findImportByContent(db, { fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-08-24" });
  assert.deepEqual([first?.id, first?.status], [on24, "applied"]);
  const second = await findImportByContent(db, { fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-08-31" });
  assert.deepEqual([second?.id, second?.status], [on31, "applied"]);
  assert.equal(await findImportByContent(db, { fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-09-07" }), null);
});
