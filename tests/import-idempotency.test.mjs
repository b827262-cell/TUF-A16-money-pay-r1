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

after(async () => {
  await vite.close();
});

const { findImportByContent } = await vite.ssrLoadModule("/lib/portfolio.ts");

const HASH = "f".repeat(64);

/** Runs the committed migration files verbatim, honoring drizzle-kit's statement separator. */
function migrate(db, ...files) {
  for (const file of files) {
    const sql = readFileSync(`${root}drizzle/${file}`, "utf8");
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const statement = chunk.trim();
      if (statement) db.exec(statement);
    }
  }
}

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  migrate(db, "0000_sudden_punisher.sql", "0001_living_miss_america.sql");
  return db;
}

/** The route reaches the lookup through D1, whose prepare/bind/first shape node:sqlite can stand in for. */
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

function addBatch(sqlite, { filename, fileHash, sourceKind, asOfDate, status = "applied" }) {
  return Number(sqlite
    .prepare("INSERT INTO imports (filename, file_hash, source_kind, row_count, as_of_date, status) VALUES (?, ?, ?, 1, ?, ?)")
    .run(filename, fileHash, sourceKind, asOfDate, status).lastInsertRowid);
}

function indexOn(sqlite, name) {
  const entry = sqlite.prepare("SELECT i.name AS name, i.`unique` AS isUnique FROM pragma_index_list('imports') i WHERE i.name = ?").get(name);
  if (!entry) return null;
  return { ...entry, columns: sqlite.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name).map((row) => row.name) };
}

test("0002 replaces the global file_hash index with the composite idempotency key", () => {
  const sqlite = openDatabase();
  // A pre-migration batch: rows already landed, so the backfill has to hand it a statistics date
  // before the composite index exists, or widening the key would silently re-open old duplicates.
  const legacyId = Number(sqlite
    .prepare("INSERT INTO imports (filename, file_hash, source_kind, row_count, created_at) VALUES (?, ?, ?, 1, ?)")
    .run("holdings-0824.csv", HASH, "stock_csv", "2026-08-24 01:30:00").lastInsertRowid);
  sqlite.prepare("INSERT INTO positions (import_id, asset_name, asset_type, source_kind) VALUES (?, '中華電', '證券', 'stock_csv')").run(legacyId);

  migrate(sqlite, "0002_as_of_import_status.sql");

  const legacy = sqlite.prepare("SELECT as_of_date AS asOfDate, status FROM imports WHERE id = ?").get(legacyId);
  assert.deepEqual([legacy.asOfDate, legacy.status], ["2026-08-24", "applied"]);
  assert.equal(indexOn(sqlite, "imports_file_hash_unique"), null);
  assert.deepEqual(indexOn(sqlite, "imports_file_hash_source_as_of_unique"), {
    name: "imports_file_hash_source_as_of_unique",
    isUnique: 1,
    columns: ["file_hash", "source_kind", "as_of_date"],
  });
});

test("identical bytes are one batch per statistics date and per source", () => {
  const sqlite = openDatabase();
  migrate(sqlite, "0002_as_of_import_status.sql");

  addBatch(sqlite, { filename: "holdings-0824.csv", fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-08-24" });
  addBatch(sqlite, { filename: "holdings-0831.csv", fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-08-31" });
  addBatch(sqlite, { filename: "holdings-0824-fund.csv", fileHash: HASH, sourceKind: "fund_csv", asOfDate: "2026-08-24" });

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imports").get().n, 3);
  assert.throws(
    () => addBatch(sqlite, { filename: "holdings-0824-retry.csv", fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-08-24" }),
    (error) => /UNIQUE constraint failed/.test(error.message)
      && error.message.includes("imports.file_hash")
      && error.message.includes("imports.source_kind")
      && error.message.includes("imports.as_of_date"),
  );
});

test("the duplicate lookup matches the whole triple so a new date imports and a pending retry resumes", async () => {
  const sqlite = openDatabase();
  migrate(sqlite, "0002_as_of_import_status.sql");
  const appliedId = addBatch(sqlite, { filename: "holdings-0824.csv", fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-08-24" });
  const pendingId = addBatch(sqlite, { filename: "holdings-0824-fund.csv", fileHash: HASH, sourceKind: "fund_csv", asOfDate: "2026-08-24", status: "pending" });
  const db = asD1(sqlite);

  // Same bytes, same date, other source: not a duplicate of the stock batch, and this one is resumable.
  const pending = await findImportByContent(db, { fileHash: HASH, sourceKind: "fund_csv", asOfDate: "2026-08-24" });
  assert.deepEqual([pending?.id, pending?.status], [pendingId, "pending"]);
  // Same bytes, another date: nothing to block, so the route inserts a second batch.
  assert.equal(await findImportByContent(db, { fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-08-31" }), null);
  // The exact triple again: this is the retry the route has to answer with 409.
  const applied = await findImportByContent(db, { fileHash: HASH, sourceKind: "stock_csv", asOfDate: "2026-08-24" });
  assert.deepEqual([applied?.id, applied?.status], [appliedId, "applied"]);
});
