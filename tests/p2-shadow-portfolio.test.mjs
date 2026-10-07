import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
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
after(async () => vite.close());

const { getShadowPortfolioAsOf, PortfolioQueryError } = await vite.ssrLoadModule("/lib/portfolio.ts");

function migrate(db, ...files) {
  for (const file of files) {
    const sql = readFileSync(root + "drizzle/" + file, "utf8");
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const statement = chunk.trim();
      if (statement) db.exec(statement);
    }
  }
}

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  migrate(db,
    "0000_sudden_punisher.sql",
    "0001_living_miss_america.sql",
    "0002_as_of_import_status.sql",
    "0003_glorious_puppet_master.sql",
    "0004_fund_risk_reward.sql",
    "0005_p2_import_identity.sql",
  );
  return db;
}

function asD1(sqlite) {
  return {
    prepare(sql) {
      let values = [];
      const statement = sqlite.prepare(sql);
      const wrapper = {
        bind(...next) { values = next; return wrapper; },
        async all() { return { results: statement.all(...values) }; },
        async first() { return statement.get(...values) ?? null; },
      };
      return wrapper;
    },
  };
}

function registerScope(db, accountKey, scopeKey, { approved = false } = {}) {
  db.prepare("INSERT INTO cutover_managed_scopes (account_key, scope_key, status, owner_approved) VALUES (?, ?, ?, ?)")
    .run(accountKey, scopeKey, approved ? "approved" : "shadow", approved ? 1 : 0);
}

function addImport(db, options) {
  const {
    filename,
    fileHash,
    sourceKind = "stock_csv",
    asOfDate = "2026-10-07",
    accountKey,
    scopeKey,
    sourceRole = "authoritative",
    coverageType = "full",
    supersedesImportId = null,
    value = 100,
  } = options;
  const result = db.prepare(
    "INSERT INTO imports " +
    "(filename, file_hash, source_kind, row_count, as_of_date, status, parser_version, " +
    "account_key, account_key_basis, scope_key, source_role, coverage_type, supersedes_import_id) " +
    "VALUES (?, ?, ?, 1, ?, 'applied', 1, ?, 'explicit', ?, ?, ?, ?)"
  ).run(filename, fileHash, sourceKind, asOfDate, accountKey, scopeKey, sourceRole, coverageType, supersedesImportId);
  const importId = Number(result.lastInsertRowid);
  db.prepare(
    "INSERT INTO positions (import_id, asset_name, asset_type, currency, market_value_twd, source_kind) " +
    "VALUES (?, ?, '證券', 'TWD', ?, ?)"
  ).run(importId, filename + "-position", value, sourceKind);
  return importId;
}

test("shadow view keeps same source_kind for different accounts", async () => {
  const sqlite = openDatabase();
  registerScope(sqlite, "acct-a", "securities");
  registerScope(sqlite, "acct-b", "securities");
  addImport(sqlite, { filename: "a.csv", fileHash: "a".repeat(64), accountKey: "acct-a", scopeKey: "securities", value: 100 });
  addImport(sqlite, { filename: "b.csv", fileHash: "b".repeat(64), accountKey: "acct-b", scopeKey: "securities", value: 200 });

  const result = await getShadowPortfolioAsOf(asD1(sqlite), "2026-10-07");
  assert.equal(result.totals.positionCount, 2);
  assert.equal(result.totals.marketValueTwd, 300);
  assert.deepEqual(result.importsUsed.map((row) => row.accountKey), ["acct-a", "acct-b"]);
});

test("shadow totals exclude supplemental and reconciliation imports", async () => {
  const sqlite = openDatabase();
  registerScope(sqlite, "acct-a", "funds");
  addImport(sqlite, { filename: "fund.csv", fileHash: "c".repeat(64), sourceKind: "fund_csv", accountKey: "acct-a", scopeKey: "funds", value: 100 });
  addImport(sqlite, { filename: "supp.mp4", fileHash: "d".repeat(64), sourceKind: "monthly_statement_video", accountKey: "acct-a", scopeKey: "funds", sourceRole: "supplemental", coverageType: "partial", value: 500 });
  addImport(sqlite, { filename: "recon.csv", fileHash: "e".repeat(64), sourceKind: "portfolio_csv", accountKey: "acct-a", scopeKey: "funds", sourceRole: "reconciliation", coverageType: "partial", value: 700 });

  const result = await getShadowPortfolioAsOf(asD1(sqlite), "2026-10-07");
  assert.equal(result.totals.positionCount, 1);
  assert.equal(result.totals.marketValueTwd, 100);
  assert.equal(result.importsUsed[0].filename, "fund.csv");
});

test("same-day correction uses explicit new-to-old supersedes chain", async () => {
  const sqlite = openDatabase();
  registerScope(sqlite, "acct-a", "securities");
  const oldId = addImport(sqlite, { filename: "old.csv", fileHash: "f".repeat(64), accountKey: "acct-a", scopeKey: "securities", value: 100 });
  addImport(sqlite, { filename: "new.csv", fileHash: "1".repeat(64), accountKey: "acct-a", scopeKey: "securities", supersedesImportId: oldId, value: 120 });

  const result = await getShadowPortfolioAsOf(asD1(sqlite), "2026-10-07");
  assert.equal(result.totals.positionCount, 1);
  assert.equal(result.totals.marketValueTwd, 120);
  assert.equal(result.importsUsed[0].filename, "new.csv");
});

test("same-day full imports without explicit chain fail closed", async () => {
  const sqlite = openDatabase();
  registerScope(sqlite, "acct-a", "securities");
  addImport(sqlite, { filename: "one.csv", fileHash: "2".repeat(64), accountKey: "acct-a", scopeKey: "securities", value: 100 });
  addImport(sqlite, { filename: "two.csv", fileHash: "3".repeat(64), accountKey: "acct-a", scopeKey: "securities", value: 120 });

  await assert.rejects(
    () => getShadowPortfolioAsOf(asD1(sqlite), "2026-10-07"),
    (error) => error instanceof PortfolioQueryError && error.message.startsWith("AMBIGUOUS_SAME_DAY:"),
  );
});

test("registered shadow scope participates before cutover approval", async () => {
  const sqlite = openDatabase();
  registerScope(sqlite, "acct-a", "securities");
  addImport(sqlite, { filename: "shadow.csv", fileHash: "4".repeat(64), accountKey: "acct-a", scopeKey: "securities", value: 321 });
  const result = await getShadowPortfolioAsOf(asD1(sqlite), "2026-10-07");
  assert.equal(result.totals.positionCount, 1);
  assert.equal(result.totals.marketValueTwd, 321);
});

test("unregistered scope stays out of V2 shadow totals", async () => {
  const sqlite = openDatabase();
  addImport(sqlite, { filename: "hidden.csv", fileHash: "5".repeat(64), accountKey: "acct-a", scopeKey: "securities", value: 999 });
  const result = await getShadowPortfolioAsOf(asD1(sqlite), "2026-10-07");
  assert.equal(result.totals.positionCount, 0);
  assert.equal(result.totals.marketValueTwd, 0);
});
