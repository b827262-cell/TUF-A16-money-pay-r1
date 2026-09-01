import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
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
after(async () => vite.close());

const { classifyPosition, normalizeExplicitPurchaseDate } = await vite.ssrLoadModule("/lib/position-classification.ts");

test("uses only an explicit source purchase date", () => {
  assert.equal(normalizeExplicitPurchaseDate("2026/9/1"), "2026-09-01");
  assert.equal(normalizeExplicitPurchaseDate("2026-02-30"), null);
  const exact = classifyPosition({ assetType: "基金", assetName: "全球大型增長股票基金", raw: { 申購日: "2026/09/01" } });
  assert.equal(exact.lastPurchaseDate, "2026-09-01");
  assert.equal(exact.purchaseDateBasis, "exact");
  const unknown = classifyPosition({ assetType: "基金", assetName: "全球大型增長股票基金", raw: { 最新淨值日期: "2026/09/01" } });
  assert.equal(unknown.lastPurchaseDate, null);
  assert.equal(unknown.purchaseDateBasis, "unknown");
});
test("classifies equity funds on the article axes without forcing them onto bonds", () => {
  const equity = classifyPosition({ assetType: "基金", assetName: "全球大型增長股票基金", raw: {} });
  assert.deepEqual(
    { category: equity.assetCategory, region: equity.investRegion, cap: equity.marketCapTier, style: equity.investStyle },
    { category: "stock_fund", region: "global", cap: "large", style: "growth" },
  );

  const bond = classifyPosition({ assetType: "基金", assetName: "PIMCO全球投資級別債券基金", raw: {} });
  assert.equal(bond.assetCategory, "bond_fund");
  assert.equal(bond.investRegion, "global");
  assert.equal(bond.marketCapTier, "not_applicable");
  assert.equal(bond.investStyle, "not_applicable");
  assert.equal(bond.industryTheme, "fixed_income");

  const balanced = classifyPosition({ assetType: "基金", assetName: "貝萊德環球資產配置基金", raw: {} });
  assert.equal(balanced.assetCategory, "balanced_fund");
  assert.equal(balanced.industryTheme, "diversified");
  assert.equal(balanced.marketCapTier, "not_applicable");
});

test("keeps ambiguous funds broad while preserving an explicit theme", () => {
  const gold = classifyPosition({ assetType: "基金", assetName: "富蘭克林黃金基金", raw: {} });
  assert.equal(gold.assetCategory, "other_fund");
  assert.equal(gold.industryTheme, "commodity");
  assert.equal(gold.marketCapTier, "not_applicable");
  assert.equal(gold.investStyle, "not_applicable");

  const cyber = classifyPosition({ assetCode: "B20306", assetType: "基金", assetName: "安聯網路資安趨勢AMf2固定月配美元", raw: {} });
  assert.equal(cyber.industryTheme, "technology");
  assert.equal(cyber.riskRewardLevel, "RR5");
  const unknownFund = classifyPosition({ assetCode: "UNKNOWN", assetType: "基金", assetName: "未核實基金", raw: {} });
  assert.equal(unknownFund.riskRewardLevel, null);
});
test("migration backfills only defensible classifications and never invents a purchase date", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_code TEXT,
    asset_name TEXT NOT NULL,
    asset_type TEXT NOT NULL
  );`);
  db.prepare("INSERT INTO positions (asset_name, asset_type) VALUES (?, ?)").run("全球大型增長股票基金", "基金");
  db.prepare("INSERT INTO positions (asset_name, asset_type) VALUES (?, ?)").run("PIMCO全球投資級別債券基金", "基金");
  db.prepare("INSERT INTO positions (asset_name, asset_type) VALUES (?, ?)").run("富蘭克林黃金基金", "基金");
  db.prepare("INSERT INTO positions (asset_name, asset_type) VALUES (?, ?)").run("神秘策略 ETF", "ETF");
  db.prepare("INSERT INTO positions (asset_code, asset_name, asset_type) VALUES (?, ?, ?)").run("1641", "多空策略基金-美元累積", "基金");
  db.prepare("INSERT INTO positions (asset_code, asset_name, asset_type) VALUES (?, ?, ?)").run("B20306", "安聯網路資安趨勢AMf2固定月配美元", "基金");

  for (const filename of ["0003_glorious_puppet_master.sql", "0004_fund_risk_reward.sql"]) {
    const sql = readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const statement = chunk.trim();
      if (statement) db.exec(statement);
    }
  }

  const rows = db.prepare("SELECT asset_name, last_purchase_date, purchase_date_basis, asset_category, invest_region, market_cap_tier, invest_style, industry_theme, risk_reward_level FROM positions ORDER BY id").all();
  assert.equal(rows[0].last_purchase_date, null);
  assert.equal(rows[0].purchase_date_basis, "unknown");
  assert.equal(rows[0].asset_category, "stock_fund");
  assert.equal(rows[0].invest_region, "global");
  assert.equal(rows[0].market_cap_tier, "large");
  assert.equal(rows[0].invest_style, "growth");
  assert.equal(rows[1].asset_category, "bond_fund");
  assert.equal(rows[1].market_cap_tier, "not_applicable");
  assert.equal(rows[1].industry_theme, "fixed_income");
  assert.equal(rows[2].asset_category, "other_fund");
  assert.equal(rows[2].industry_theme, "commodity");
  assert.equal(rows[3].asset_category, "etf_other");
  assert.equal(rows[3].last_purchase_date, null);
  assert.equal(rows[4].asset_name, "富蘭克林多空策略基金-美元累積");
  assert.equal(rows[4].risk_reward_level, "RR3");
  assert.equal(rows[5].industry_theme, "technology");
  assert.equal(rows[5].risk_reward_level, "RR5");
  db.close();
});
