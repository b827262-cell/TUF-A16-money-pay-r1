import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function migrate(db) {
  for (const file of [
    "0000_sudden_punisher.sql",
    "0001_living_miss_america.sql",
    "0002_as_of_import_status.sql",
    "0003_glorious_puppet_master.sql",
    "0004_fund_risk_reward.sql",
    "0005_p2_import_identity.sql",
  ]) {
    const sql = readFileSync(root + "drizzle/" + file, "utf8");
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const statement = chunk.trim();
      if (statement) db.exec(statement);
    }
  }
}

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

function insertLegacy(db, { filename, fileHash, asOfDate = "2026-10-07" }) {
  return db.prepare(
    "INSERT INTO imports (filename,file_hash,source_kind,row_count,as_of_date,status,parser_version) " +
    "VALUES (?,?,'stock_csv',1,?,'applied',1)"
  ).run(filename, fileHash, asOfDate);
}

function insertP2(db, {
  filename,
  fileHash,
  accountKey,
  logicalKey,
  contentHash,
  asOfDate = "2026-10-07",
  supersedesImportId = null,
}) {
  return db.prepare(
    "INSERT INTO imports (" +
    "filename,file_hash,source_kind,row_count,as_of_date,status,parser_version," +
    "account_key,account_key_basis,scope_key,source_role,coverage_type," +
    "logical_import_key,logical_import_key_version,canonical_content_hash,supersedes_import_id" +
    ") VALUES (?,?,'stock_csv',1,?,'applied',1,?,'explicit','securities','authoritative','full',?,'logical_import/v0.1',?,?)"
  ).run(filename, fileHash, asOfDate, accountKey, logicalKey, contentHash, supersedesImportId);
}

test("legacy triple uniqueness is preserved by partial index", () => {
  const db = openDatabase();
  insertLegacy(db, { filename: "a.csv", fileHash: "a".repeat(64) });
  assert.throws(
    () => insertLegacy(db, { filename: "b.csv", fileHash: "a".repeat(64) }),
    /UNIQUE constraint failed/,
  );
});

test("same bytes/source/date are allowed across different P2 accounts", () => {
  const db = openDatabase();
  const hash = "b".repeat(64);
  insertP2(db, { filename: "a.csv", fileHash: hash, accountKey: "acct-a", logicalKey: "slot-a", contentHash: "content-a" });
  insertP2(db, { filename: "b.csv", fileHash: hash, accountKey: "acct-b", logicalKey: "slot-b", contentHash: "content-b" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM imports").get().n, 2);
});

test("same account/scope/bytes/source/date is still idempotent", () => {
  const db = openDatabase();
  const hash = "c".repeat(64);
  insertP2(db, { filename: "a.csv", fileHash: hash, accountKey: "acct-a", logicalKey: "slot-a", contentHash: "content-a" });
  assert.throws(
    () => insertP2(db, { filename: "b.csv", fileHash: hash, accountKey: "acct-a", logicalKey: "slot-b", contentHash: "content-b" }),
    /UNIQUE constraint failed/,
  );
});

test("same logical slot permits a changed revision but rejects semantic replay", () => {
  const db = openDatabase();
  const first = insertP2(db, {
    filename: "rev1.csv",
    fileHash: "d".repeat(64),
    accountKey: "acct-a",
    logicalKey: "slot-a",
    contentHash: "content-v1",
  });
  insertP2(db, {
    filename: "rev2.csv",
    fileHash: "e".repeat(64),
    accountKey: "acct-a",
    logicalKey: "slot-a",
    contentHash: "content-v2",
    supersedesImportId: Number(first.lastInsertRowid),
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM imports WHERE logical_import_key='slot-a'").get().n, 2);

  assert.throws(
    () => insertP2(db, {
      filename: "replay.csv",
      fileHash: "f".repeat(64),
      accountKey: "acct-a",
      logicalKey: "slot-a",
      contentHash: "content-v2",
    }),
    /UNIQUE constraint failed/,
  );
});

test("registered account mapping requires explicit approval provenance", () => {
  const db = openDatabase();
  db.prepare("INSERT INTO account_source_mappings (mapping_key, source_kind, account_key, scope_key) VALUES (?, 'stock_csv', 'acct-a', 'securities')")
    .run("broker-primary");

  const lookup = () => db.prepare(
    "SELECT account_key AS accountKey, scope_key AS scopeKey FROM account_source_mappings " +
    "WHERE mapping_key = ? AND source_kind = ? AND status = 'approved' " +
    "AND approved_by IS NOT NULL AND approved_at IS NOT NULL LIMIT 1"
  ).get("broker-primary", "stock_csv");

  assert.equal(lookup(), undefined);
  db.prepare("UPDATE account_source_mappings SET status='approved' WHERE mapping_key='broker-primary'").run();
  assert.equal(lookup(), undefined);
  db.prepare("UPDATE account_source_mappings SET approved_by='owner', approved_at='2026-10-07T14:00:00+08:00' WHERE mapping_key='broker-primary'").run();
  const approved = lookup();
  assert.equal(approved?.accountKey, "acct-a");
  assert.equal(approved?.scopeKey, "securities");
});
