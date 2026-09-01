/**
 * End-to-end coverage for scripts/sync-sqlite-to-sites.mjs.
 *
 * The CLI is spawned as a real subprocess against a local mock of the four deployed endpoints, so
 * "dry-run touches nothing" and "verification mismatch exits nonzero" are observed, not inferred.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { applyPlan } from "../scripts/sites-sync/apply.mjs";
import { expectedPortfolioAsOf } from "../scripts/sites-sync/sqlite-source.mjs";
import { classifyTarget } from "../scripts/sites-sync/sites-client.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = resolve(root, "scripts/sync-sqlite-to-sites.mjs");
const workDir = mkdtempSync(join(tmpdir(), "sites-sync-"));
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4ff0000000a49444154789c6300010000050001", "hex");

/* ------------------------------------------------------------------ fixtures */

function migrate(db, ...files) {
  for (const file of files) {
    const sql = readFileSync(join(root, "drizzle", file), "utf8");
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const statement = chunk.trim();
      if (statement) db.exec(statement);
    }
  }
}

/** A database shaped exactly like the deployed one, built from the committed migrations. */
function createSourceSqlite(name, seed) {
  const path = join(workDir, `${name}.sqlite`);
  const db = new DatabaseSync(path);
  migrate(db, "0000_sudden_punisher.sql", "0001_living_miss_america.sql", "0002_as_of_import_status.sql", "0003_glorious_puppet_master.sql");
  seed(db);
  db.close();
  return path;
}

function addImport(db, { filename, fileHash, sourceKind, asOfDate, status = "applied", parserVersion = 1, rows }) {
  const importId = Number(db
    .prepare("INSERT INTO imports (filename, file_hash, source_kind, row_count, as_of_date, status, parser_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(filename, fileHash, sourceKind, rows.length, asOfDate, status, parserVersion, "2026-08-24 01:30:00").lastInsertRowid);
  const statement = db.prepare(`INSERT INTO positions
    (import_id, asset_code, asset_name, asset_type, currency, units, avg_cost, market_price, cost_basis_twd, market_value_twd, pnl_twd, return_pct, dividend_twd, valuation_date, source_kind, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [index, position] of rows.entries()) {
    statement.run(
      importId, position.assetCode ?? null, position.assetName ?? "中華電", position.assetType ?? "證券", position.currency ?? "TWD",
      position.units ?? 100, position.avgCost ?? 10, position.marketPrice ?? 12, position.costBasisTwd ?? 1000, position.marketValueTwd ?? 1200,
      position.pnlTwd ?? 200, position.returnPct ?? 20, position.dividendTwd ?? 50, position.valuationDate ?? "2026-08-24", sourceKind,
      JSON.stringify(position.raw ?? { 股票名稱: position.assetName ?? "中華電" }), `2026-08-${String((index % 28) + 1).padStart(2, "0")} 01:30:00`,
    );
  }
  return importId;
}

const stockRow = (assetName, marketValueTwd, extra = {}) => ({ assetName, marketValueTwd, ...extra });

function fundRow(name = "元大台灣50") {
  return {
    assetCode: "0050",
    assetName: name,
    assetType: "基金",
    units: 100,
    avgCost: 20.5,
    marketPrice: 22.75,
    costBasisTwd: 2050,
    marketValueTwd: 2275,
    pnlTwd: 225,
    returnPct: 10.98,
    dividendTwd: 150,
    valuationDate: "2026-08-24",
    raw: { 基金代碼: "0050", 基金名稱: name },
  };
}

function addOcr(db, { objectKey = "ocr/1755-uuid-shot.png", filename = "shot.png", rawText = "持總市值 1,234,567", extractedJson = '{"marketValueTwd":1234567}', confidence = 0.93, reviewStatus = "reviewed" } = {}) {
  return Number(db
    .prepare("INSERT INTO ocr_documents (object_key, filename, doc_type, raw_text, extracted_json, confidence, review_status, created_at) VALUES (?, ?, 'investment_screenshot', ?, ?, ?, ?, ?)")
    .run(objectKey, filename, rawText, extractedJson, confidence, reviewStatus, "2026-08-24 02:00:00").lastInsertRowid);
}

function addSnapshot(db, snapshotDate, totals = {}) {
  return Number(db
    .prepare("INSERT INTO portfolio_snapshots (snapshot_date, position_count, cost_basis_twd, market_value_twd, pnl_twd, dividend_twd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(snapshotDate, totals.positionCount ?? 1, totals.costBasisTwd ?? 1000, totals.marketValueTwd ?? 1200, totals.pnlTwd ?? 200, totals.dividendTwd ?? 50, "2026-08-24 03:00:00").lastInsertRowid);
}

/* ------------------------------------------------------------------ mock site */

/**
 * One listener serves every mock site through its own URL prefix: an ephemeral port only exists
 * after the async bind, and prefixes let the tests keep creating sites from synchronous bodies.
 */
const routes = new Map();
let siteCounter = 0;
const listener = createServer((request, response) => {
  const [, prefix] = request.url.split("/");
  const dispatch = routes.get(prefix);
  if (!dispatch) return respond(response, 404, { error: `no mock site mounted at /${prefix}` });
  dispatch(request, response);
});
await new Promise((resolveListen) => listener.listen(0, "127.0.0.1", resolveListen));
const listenerOrigin = `http://127.0.0.1:${listener.address().port}`;

after(() => listener.close());

/**
 * Stands in for the deployed app and keeps the rules the real routes enforce: the
 * (fileHash, sourceKind, asOfDate) idempotency triple, the 1,000-row cap, 409 on a replayed
 * snapshot date, and the per-source_kind ranking GET /api/portfolio answers with.
 */
function createMockSite() {
  const prefix = `site-${(siteCounter += 1)}`;
  const state = { imports: [], positions: [], snapshots: [], ocrDocuments: [], requests: [], nextImportId: 1, nextSnapshotId: 1, nextOcrId: 1 };
  const site = { state, requests: state.requests, tamper: null, queued: [], crashNextImport: false };
  site.failOnce = (path, status, json) => {
    site.queued.push({ path, status, json });
    return site;
  };
  /** Answers 401 until the named request header shows up, like the deployed site's own auth gate. */
  site.requireHeader = (name) => {
    site.requiredHeader = name.toLowerCase();
    return site;
  };
  /** Dies after the pending `imports` row exists but before its positions land, like a server losing the request mid-flight. */
  site.crashOnNextImport = () => {
    site.crashNextImport = true;
    return site;
  };

  function asOfPortfolio(asOfDate) {
    const eligible = state.imports.filter((item) => item.status === "applied" && item.asOfDate && (!asOfDate || item.asOfDate <= asOfDate));
    const current = new Map();
    for (const item of eligible) {
      const best = current.get(item.sourceKind);
      if (!best || item.asOfDate > best.asOfDate || (item.asOfDate === best.asOfDate && item.id > best.id)) current.set(item.sourceKind, item);
    }
    const importsUsed = [...current.values()].sort((a, b) => a.sourceKind.localeCompare(b.sourceKind));
    const ids = new Set(importsUsed.map((item) => item.id));
    const positions = state.positions.filter((position) => ids.has(position.importId));
    const totals = positions.reduce((sum, position) => ({
      positionCount: sum.positionCount + 1,
      costBasisTwd: sum.costBasisTwd + position.costBasisTwd,
      marketValueTwd: sum.marketValueTwd + position.marketValueTwd,
      pnlTwd: sum.pnlTwd + position.pnlTwd,
      dividendTwd: sum.dividendTwd + position.dividendTwd,
    }), { positionCount: 0, costBasisTwd: 0, marketValueTwd: 0, pnlTwd: 0, dividendTwd: 0 });
    const dataAsOf = importsUsed.reduce((latest, item) => (!latest || item.asOfDate > latest ? item.asOfDate : latest), null);
    return { importsUsed, positions, totals, dataAsOf };
  }

  const describe = (item) => ({ id: item.id, filename: item.filename, sourceKind: item.sourceKind, rowCount: item.rowCount, asOfDate: item.asOfDate, status: item.status, parserVersion: item.parserVersion, createdAt: item.createdAt });

  async function handle(request, response) {
    const url = new URL(request.url.slice(prefix.length + 1) || "/", listenerOrigin);
    let body = null;
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
    state.requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, raw: body });

    if (site.requiredHeader && !(site.requiredHeader in request.headers)) {
      respond(response, 401, { error: "未授權" });
      return;
    }

    const queued = site.queued.findIndex((entry) => entry.path === url.pathname);
    if (queued !== -1) {
      const [entry] = site.queued.splice(queued, 1);
      respond(response, entry.status, entry.json);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/portfolio") {
      const asOfDate = url.searchParams.get("asOf");
      const portfolio = asOfPortfolio(asOfDate);
      const json = {
        asOfDate: asOfDate ?? null,
        dataAsOf: portfolio.dataAsOf,
        totals: portfolio.totals,
        positions: portfolio.positions.map((position) => ({ id: position.id, assetName: position.assetName, assetType: position.assetType, sourceKind: position.sourceKind, marketValueTwd: position.marketValueTwd })),
        importsUsed: portfolio.importsUsed.map(describe),
        imports: [...state.imports].sort((a, b) => b.id - a.id).slice(0, 20).map(describe),
        ocrDocuments: [...state.ocrDocuments].sort((a, b) => b.id - a.id).slice(0, 20).map((document) => ({ id: document.id, filename: document.filename, docType: document.docType, confidence: document.confidence, reviewStatus: document.reviewStatus, createdAt: document.createdAt })),
        availableDates: [...new Set(state.imports.filter((item) => item.status === "applied" && item.asOfDate).map((item) => item.asOfDate))].sort().reverse().slice(0, 365),
      };
      respond(response, 200, site.tamper ? site.tamper(json) : json);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/import") {
      const payload = JSON.parse(body.toString("utf8"));
      const filename = payload.filename?.trim();
      const fileHash = payload.fileHash?.trim();
      const sourceKind = payload.sourceKind?.trim();
      const rows = payload.rows ?? [];
      if (!filename || !fileHash || !sourceKind || !rows.length) return respond(response, 400, { error: "匯入資訊不完整" });
      if (rows.length > 1000) return respond(response, 400, { error: "單次最多匯入 1,000 筆" });
      // app/api/import/route.ts falls back to the Taipei当天 when the date is absent; keep that observable.
      const asOfDate = payload.asOfDate || "2026-09-01";
      const existing = state.imports.find((item) => item.fileHash === fileHash && item.sourceKind === sourceKind && item.asOfDate === asOfDate);
      if (existing?.status === "applied") return respond(response, 409, { error: "這份檔案已匯入，不會重複計算", importId: existing.id });
      let importId = existing?.id;
      if (!importId) {
        importId = state.nextImportId++;
        state.imports.push({ id: importId, filename, fileHash, sourceKind, rowCount: 0, asOfDate, status: "pending", parserVersion: 1, createdAt: "2026-09-01 00:00:00" });
      }
      if (site.crashNextImport) {
        site.crashNextImport = false;
        return respond(response, 500, { error: "匯入失敗" });
      }
      for (const position of rows) {
        state.positions.push({
          id: state.positions.length + 1, importId, assetCode: position.assetCode ?? null, assetName: position.assetName, assetType: position.assetType,
          currency: position.currency ?? "TWD", units: position.units ?? 0, avgCost: position.avgCost ?? 0, marketPrice: position.marketPrice ?? 0,
          costBasisTwd: position.costBasisTwd ?? 0, marketValueTwd: position.marketValueTwd ?? 0, pnlTwd: position.pnlTwd ?? 0,
          returnPct: position.returnPct ?? 0, dividendTwd: position.dividendTwd ?? 0, valuationDate: position.valuationDate ?? null,
          sourceKind, rawJson: JSON.stringify(position.raw ?? {}), createdAt: "2026-09-01 00:00:00",
        });
      }
      Object.assign(state.imports.find((item) => item.id === importId), { status: "applied", rowCount: rows.length, asOfDate });
      respond(response, 201, { imported: rows.length, importId, asOfDate, status: "applied" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/snapshots") {
      const { snapshotDate } = JSON.parse(body.toString("utf8"));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snapshotDate ?? ""))) return respond(response, 400, { error: "統計日期格式必須是 YYYY-MM-DD" });
      if (state.snapshots.some((item) => item.snapshotDate === snapshotDate)) return respond(response, 409, { error: "此日期已有統計快照，請改選其他日期" });
      const portfolio = asOfPortfolio(snapshotDate);
      if (!portfolio.totals.positionCount) return respond(response, 400, { error: "該日期尚無已套用的持倉資料，無法建立快照" });
      const id = state.nextSnapshotId++;
      state.snapshots.push({ id, snapshotDate, totals: portfolio.totals });
      respond(response, 201, { id, snapshotDate, totals: portfolio.totals, importsUsed: portfolio.importsUsed.map(describe) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ocr") {
      const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData();
      const file = form.get("file");
      const rawText = String(form.get("rawText") ?? "").trim();
      const extractedJson = String(form.get("extractedJson") ?? "{}");
      if (!(file instanceof File) || !rawText) return respond(response, 400, { error: "請提供圖片與校對文字" });
      if (file.size > 10 * 1024 * 1024) return respond(response, 400, { error: "圖片不可超過 10MB" });
      JSON.parse(extractedJson);
      state.ocrDocuments.push({
        id: state.nextOcrId++, objectKey: `ocr/fixed-${state.nextOcrId}-${file.name}`, filename: file.name,
        docType: String(form.get("docType") ?? "investment_screenshot"), rawText, extractedJson, confidence: Number(form.get("confidence") ?? 0),
        reviewStatus: "reviewed", bytes: file.size, createdAt: "2026-08-24 02:00:00",
      });
      respond(response, 201, { id: state.nextOcrId - 1 });
      return;
    }

    respond(response, 404, { error: "not found" });
  }

  routes.set(prefix, (request, response) => {
    handle(request, response).catch((error) => respond(response, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
  site.baseUrl = `${listenerOrigin}/${prefix}`;
  site.close = () => routes.delete(prefix);
  return site;
}

function respond(response, status, json) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(json));
}

/* ------------------------------------------------------------------ runner */

/** The mock site shares this process's event loop, so the CLI has to be spawned, never run synchronously. */
async function runCli(args, { env = {} } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status: status ?? 1, stdout, stderr });
    });
  });
}

let planCounter = 0;

/** Runs the dry-runnest dry-run there is and hands back the plan JSON. */
async function planFor(dbPath, extra = [], { site = null } = {}) {
  const planPath = join(workDir, `plan-${(planCounter += 1)}.json`);
  const result = await runCli(["--db", dbPath, "--site", site?.baseUrl ?? "http://127.0.0.1:9", "--plan-json", planPath, ...extra]);
  return { plan: JSON.parse(readFileSync(planPath, "utf8")), result };
}

function postPaths(site) {
  return postsOf(site.requests);
}

function postsOf(requests) {
  return requests.filter((request) => request.method === "POST").map((request) => request.path);
}

function requestRecord(request) {
  return `${request.method} ${request.path}`;
}

/** The pre-0002 GET /api/portfolio body: raw rows only, no as-of totals, importsUsed or date list. */
function versionTwoPortfolio(json) {
  return { positions: json.positions, imports: json.imports, ocrDocuments: json.ocrDocuments, snapshots: [] };
}

/* ------------------------------------------------------------------ tests */

test("dry-run writes nothing and opens no request to the site", async () => {
  const dbPath = createSourceSqlite("dry-run", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addOcr(db);
    addSnapshot(db, "2026-08-24");
  });
  const site = createMockSite();
  const summaryPath = join(workDir, "dry-run-summary.json");

  const result = await runCli(["--db", dbPath, "--site", site.baseUrl, "--plan-json", join(workDir, "dry-run-plan.json"), "--summary-json", summaryPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(site.requests.length, 0, `dry-run 不應該送出任何請求：${JSON.stringify(site.requests.map((request) => request.path))}`);
  assert.match(result.stdout, /DRY-RUN（不送任何請求）/);
  assert.match(result.stdout, /跳過 id=1 shot\.png[\s\S]*OCR_IMAGE_BYTES_NOT_IN_SQLITE/);
  assert.match(result.stderr, /dry-run 完成：未送出任何請求/);

  const plan = JSON.parse(readFileSync(join(workDir, "dry-run-plan.json"), "utf8"));
  assert.equal(plan.mode, "dry-run");
  assert.deepEqual({ imports: plan.totals.imports, positions: plan.totals.positions, dates: plan.dates }, { imports: 1, positions: 1, dates: ["2026-08-24"] });
  assert.deepEqual(plan.target, { baseUrl: site.baseUrl, hostname: "127.0.0.1", environment: "local", scheme: "http" });
  assert.equal(plan.snapshots[0].status, "skipped");
  assert.equal(plan.snapshots[0].code, "SNAPSHOT_STAGE_DISABLED");
  assert.equal(plan.ocrDocuments[0].code, "OCR_IMAGE_BYTES_NOT_IN_SQLITE");

  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.deepEqual({ mode: summary.mode, exitCode: summary.exitCode, requestsSent: summary.requestsSent, results: summary.results }, { mode: "dry-run", exitCode: 0, requestsSent: null, results: null });

  // "-" promises stdout is pure JSON, so the text report has to step aside to stderr.
  const piped = await runCli(["--db", dbPath, "--site", site.baseUrl, "--plan-json", "-"]);
  assert.equal(piped.status, 0, piped.stderr);
  assert.deepEqual(JSON.parse(piped.stdout).totals.imports, 1);
  assert.match(piped.stderr, /DRY-RUN（不送任何請求）/);
  site.close();
});

test("--plan-json／--summary-json 落檔 0600，覆寫後仍是 0600", async () => {
  const dbPath = createSourceSqlite("output-mode", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const planPath = join(workDir, "output-mode-plan.json");
  const summaryPath = join(workDir, "output-mode-summary.json");
  const modeOf = (path) => statSync(path).mode & 0o777;
  const args = ["--db", dbPath, "--site", "http://127.0.0.1:9", "--plan-json", planPath, "--summary-json", summaryPath];

  const created = await runCli(args);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(modeOf(planPath), 0o600, "新建的遷移計畫含真實金額，不可群組或他人可讀");
  assert.equal(modeOf(summaryPath), 0o600, "新建的結果摘要含真實金額，不可群組或他人可讀");

  chmodSync(planPath, 0o644);
  chmodSync(summaryPath, 0o666);
  const rewritten = await runCli(args);
  assert.equal(rewritten.status, 0, rewritten.stderr);
  assert.equal(modeOf(planPath), 0o600, "覆寫既有遷移計畫時要把權限壓回 0600");
  assert.equal(modeOf(summaryPath), 0o600, "覆寫既有結果摘要時要把權限壓回 0600");
  assert.equal(JSON.parse(readFileSync(summaryPath, "utf8")).mode, "dry-run", "壓權限不能順便改寫內容");
});

test("positions map onto exactly the /api/import canonical row payload", async () => {
  const dbPath = createSourceSqlite("mapping", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow(), fundRow("00620 元大高股息")] });
  });
  const { plan } = await planFor(dbPath);
  assert.equal(plan.imports.length, 1);
  const [item] = plan.imports;
  assert.deepEqual(Object.keys(item.request), ["method", "path", "headers", "body"]);
  assert.equal(item.request.method, "POST");
  assert.equal(item.request.path, "/api/import");
  assert.deepEqual(Object.keys(item.request.body), ["filename", "fileHash", "sourceKind", "asOfDate", "rows"]);
  assert.deepEqual(
    { filename: item.request.body.filename, fileHash: item.request.body.fileHash, sourceKind: item.request.body.sourceKind, asOfDate: item.request.body.asOfDate },
    { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24" },
  );
  assert.deepEqual(item.request.body.rows[0], {
    assetCode: "0050",
    assetName: "元大台灣50",
    assetType: "基金",
    currency: "TWD",
    units: 100,
    avgCost: 20.5,
    marketPrice: 22.75,
    costBasisTwd: 2050,
    marketValueTwd: 2275,
    pnlTwd: 225,
    returnPct: 10.98,
    dividendTwd: 150,
    valuationDate: "2026-08-24",
    raw: { 基金代碼: "0050", 基金名稱: "元大台灣50" },
  });
  assert.deepEqual(item.amounts, { positionCount: 2, costBasisTwd: 4100, marketValueTwd: 4550, pnlTwd: 450, dividendTwd: 300 });
  assert.deepEqual(plan.amounts, item.amounts);
  assert.deepEqual(plan.source.positions, { planned: 2, pendingBatch: 0, noBatch: 0 });
});

test("the idempotency triple travels unchanged and is never re-derived", async () => {
  const dbPath = createSourceSqlite("idempotency", (db) => {
    // Same bytes on two dates and on two sources: three distinct batches that must stay three.
    addImport(db, { filename: "holdings-0824.csv", fileHash: HASH_A, sourceKind: "stock_csv", asOfDate: "2026-08-24", rows: [stockRow("中華電", 1200)] });
    addImport(db, { filename: "holdings-0831.csv", fileHash: HASH_A, sourceKind: "stock_csv", asOfDate: "2026-08-31", rows: [stockRow("中華電", 1300)] });
    addImport(db, { filename: "holdings-0824-fund.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addImport(db, { filename: "pending.csv", fileHash: HASH_B, sourceKind: "stock_csv", asOfDate: "2026-09-07", status: "pending", rows: [stockRow("台積電", 9999)] });
  });
  const { plan } = await planFor(dbPath);
  assert.equal(plan.imports.length, 3, "只有 status='applied' 的批次會進入計畫");
  assert.deepEqual(
    plan.imports.map((item) => `${item.fileHash[0]}|${item.sourceKind}|${item.asOfDate}|${item.filename}|${item.positionCount}`),
    // Oldest statistics date first, and within one date the local id order: the fund batch was
    // imported third locally, so it is replayed third.
    ["a|stock_csv|2026-08-24|holdings-0824.csv|1", "a|fund_csv|2026-08-24|holdings-0824-fund.csv|1", "a|stock_csv|2026-08-31|holdings-0831.csv|1"],
  );
  assert.equal(new Set(plan.imports.map((item) => item.idempotencyKey)).size, 3);
  const expectedRaw = {
    "holdings-0824.csv": { 股票名稱: "中華電" },
    "holdings-0831.csv": { 股票名稱: "中華電" },
    "holdings-0824-fund.csv": { 基金代碼: "0050", 基金名稱: "元大台灣50" },
  };
  for (const item of plan.imports) {
    assert.equal(item.request.body.fileHash, HASH_A, "不得假造新的 file_hash");
    assert.equal(item.request.body.sourceKind, item.sourceKind, "不得假造新的 source_kind");
    assert.equal(item.request.body.asOfDate, item.asOfDate, "不得假造新的 as_of_date");
    assert.equal(item.request.body.rows[0].sourceKind, undefined, "source_kind 由批次帶入，不是持倉欄位");
    assert.deepEqual(item.request.body.rows[0].raw, expectedRaw[item.filename], "raw_json 要原樣送回");
  }
  assert.deepEqual(plan.source.positions, { planned: 3, pendingBatch: 1, noBatch: 0 });
});

test("batches that share a source and a date shadow each other identically on both sides", async () => {
  const dbPath = createSourceSqlite("shadowing", (db) => {
    // Two different files, same source_kind, same statistics date: the route accepts both, and the
    // per-source_kind ranking then counts only the newest id. Replay order decides which one that is.
    addImport(db, { filename: "stock-first.csv", fileHash: HASH_A, sourceKind: "stock_csv", asOfDate: "2026-08-24", rows: [stockRow("中華電", 1200)] });
    addImport(db, { filename: "stock-second.csv", fileHash: HASH_B, sourceKind: "stock_csv", asOfDate: "2026-08-24", rows: [stockRow("中華電", 1500)] });
  });
  const site = createMockSite();
  const { plan } = await planFor(dbPath, [], { site });
  assert.deepEqual(plan.imports.map((item) => item.filename), ["stock-first.csv", "stock-second.csv"], "本機 id 順序要維持，伺服器才會選到同一個批次");

  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(expectedPortfolioAsOf(sqlite, "2026-08-24").totals.marketValueTwd, 1500, "本機只計入最新一筆");
  sqlite.close();

  const applied = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(postPaths(site), ["/api/import", "/api/import"]);
  const portfolio = await (await fetch(`${site.baseUrl}/api/portfolio?asOf=2026-08-24`)).json();
  assert.equal(portfolio.totals.marketValueTwd, 1500);
  assert.deepEqual(portfolio.importsUsed.map((item) => item.filename), ["stock-second.csv"]);
  site.close();
});

test("a batch larger than the 1,000-row API cap fails closed instead of chunking", async () => {
  const big = Array.from({ length: 1001 }, (_, index) => stockRow(`持倉 ${index}`, 1000 + index));
  const dbPath = createSourceSqlite("row-cap", (db) => {
    addImport(db, { filename: "giant.csv", fileHash: HASH_A, sourceKind: "stock_csv", asOfDate: "2026-08-24", rows: big });
    addImport(db, { filename: "ok.csv", fileHash: HASH_B, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addSnapshot(db, "2026-08-24");
  });
  const site = createMockSite();
  const { plan, result } = await planFor(dbPath, ["--with-snapshots"], { site });
  assert.equal(result.status, 2, "無法套用的計畫要用非零碼回報");

  assert.deepEqual(plan.totals, {
    imports: 1,
    importRequests: 1,
    positions: 1,
    ocrPlanned: 0,
    ocrSkipped: 0,
    snapshotsPlanned: 0,
    snapshotsSkipped: 1,
    blocked: 1,
    verificationDates: 1,
  });
  const blocked = plan.imports.find((item) => item.status === "blocked");
  assert.equal(blocked.code, "IMPORT_ROW_CAP_EXCEEDED");
  assert.equal(blocked.positionCount, 1001);
  assert.equal(blocked.request, undefined);
  assert.deepEqual(plan.rowCapConflict.detected.map((item) => [item.filename, item.positionCount]), [["giant.csv", 1001]]);
  assert.match(plan.rowCapConflict.summary, /沒有任何受支援的分塊協定/);
  assert.deepEqual(plan.rowCapConflict.unsafeAlternatives.map((item) => item.attempt), ["同冪等鍵分塊重送", "假造新的 file_hash", "假造 source_kind 後綴", "假造 as_of_date"]);
  assert.deepEqual(plan.snapshots[0].code, "SNAPSHOT_DEPENDS_ON_BLOCKED_IMPORT");
  assert.deepEqual(plan.snapshots[0].blockedImports, [{ localImportId: plan.imports.find((i) => i.filename === "giant.csv").localImportId, filename: "giant.csv", sourceKind: "stock_csv", asOfDate: "2026-08-24", code: "IMPORT_ROW_CAP_EXCEEDED" }]);

  const attempted = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target"]);
  assert.equal(attempted.status, 2);
  assert.match(attempted.stderr, /已拒絕寫入/);
  assert.match(attempted.stderr, /POST \/api\/import\/session/);
  assert.deepEqual(postPaths(site), [], "被擋下時一個寫入請求都不該送出去");
  assert.equal(attempted.stdout.match(/持倉 1000/g), null, "被擋下的批次不該把 1001 筆明細印出來");
  site.close();
});

test("OCR metadata is reported as unsyncable unless the image bytes really exist", async () => {
  const dbPath = createSourceSqlite("ocr", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addOcr(db);
    addOcr(db, { objectKey: "ocr/missing.png", filename: "missing.png" });
    addOcr(db, { objectKey: "ocr/no-text.png", filename: "no-text.png", rawText: "   " });
    addOcr(db, { objectKey: "ocr/bad-json.png", filename: "bad-json.png", extractedJson: "{not json" });
    addOcr(db, { objectKey: "ocr/review.png", filename: "review.png", reviewStatus: "pending_review" });
  });
  const site = createMockSite();

  const { plan: withoutDir } = await planFor(dbPath, [], { site });
  assert.equal(withoutDir.totals.ocrSkipped, 5);
  // A payload the route would reject anyway is named first: the missing image changes nothing about it.
  assert.deepEqual(withoutDir.ocrDocuments.map((item) => item.code), [
    "OCR_IMAGE_BYTES_NOT_IN_SQLITE",
    "OCR_IMAGE_BYTES_NOT_IN_SQLITE",
    "OCR_EMPTY_RAW_TEXT",
    "OCR_INVALID_EXTRACTED_JSON",
    "OCR_REVIEW_STATUS_NOT_PRESERVABLE",
  ]);
  assert.equal(withoutDir.ocrDocuments[0].request, undefined);
  assert.match(withoutDir.ocrDocuments[0].reason, /圖片位元組不在 SQLite 內/);

  const imageDir = join(workDir, "ocr-images");
  mkdirSync(imageDir, { recursive: true });
  const { plan: withDir } = await planFor(dbPath, ["--ocr-image-dir", imageDir], { site });
  assert.deepEqual(withDir.ocrDocuments.map((item) => item.code), [
    "OCR_LOCAL_IMAGE_NOT_FOUND",
    "OCR_LOCAL_IMAGE_NOT_FOUND",
    "OCR_EMPTY_RAW_TEXT",
    "OCR_INVALID_EXTRACTED_JSON",
    "OCR_REVIEW_STATUS_NOT_PRESERVABLE",
  ]);
  assert.equal(withDir.totals.ocrPlanned, 0);
  assert.match(withDir.ocrDocuments[4].reason, /review_status/);

  const applied = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target", "--ocr-image-dir", imageDir]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(postPaths(site), ["/api/import"], "沒有原圖時只匯入，絕不偽造 OCR 文件");
  assert.equal(site.state.ocrDocuments.length, 0);
  site.close();
});

test("an OCR document with a local image uploads as multipart and journals the result", async () => {
  const dbPath = createSourceSqlite("ocr-upload", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addOcr(db, { objectKey: "ocr/shot-1.png", filename: "shot 1.png" });
  });
  const imageDir = join(workDir, "upload-images");
  mkdirSync(join(imageDir, "ocr"), { recursive: true });
  writeFileSync(join(imageDir, "ocr", "shot-1.png"), PNG);
  const site = createMockSite();
  const statePath = join(workDir, "ocr-state.json");
  const args = ["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target", "--ocr-image-dir", imageDir, "--state", statePath];

  const { plan } = await planFor(dbPath, ["--ocr-image-dir", imageDir], { site });
  assert.equal(plan.ocrDocuments[0].status, "planned");
  assert.deepEqual(plan.ocrDocuments[0].image.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.deepEqual(Object.keys(plan.ocrDocuments[0].request.multipart), ["fields", "file"]);
  assert.deepEqual(plan.ocrDocuments[0].request.multipart.fields, { rawText: "持總市值 1,234,567", extractedJson: '{"marketValueTwd":1234567}', docType: "investment_screenshot", confidence: "0.93" });

  const first = await runCli(args);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(postPaths(site), ["/api/import", "/api/ocr"]);
  const ocrRequest = site.requests.find((request) => request.path === "/api/ocr");
  const form = await new Response(ocrRequest.raw, { headers: { "content-type": ocrRequest.headers["content-type"] } }).formData();
  assert.equal(form.get("rawText"), "持總市值 1,234,567");
  assert.equal(form.get("docType"), "investment_screenshot");
  assert.equal(form.get("confidence"), "0.93");
  assert.deepEqual(JSON.parse(form.get("extractedJson")), { marketValueTwd: 1234567 });
  const file = form.get("file");
  assert.equal(file.name, "shot 1.png", "ocr_documents.filename 必須原樣保留");
  assert.equal(file.type, "image/png");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  assert.equal(site.state.ocrDocuments.length, 1);
  const journal = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(Object.keys(journal.completed), ["ocr:1|ocr/shot-1.png"]);
  assert.equal(journal.completed["ocr:1|ocr/shot-1.png"].serverDocumentId, 1);

  const second = await runCli(args);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(postPaths(site).filter((path) => path === "/api/ocr").length, 1, "狀態檔要讓第二次執行跳過 OCR，避免重複文件");
  assert.equal(site.state.ocrDocuments.length, 1);
  assert.match(second.stdout, /狀態檔記錄過，跳過/);

  // Without --state the same document must be refused rather than blindly re-uploaded.
  const noJournal = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target", "--ocr-image-dir", imageDir]);
  assert.equal(noJournal.status, 0, noJournal.stderr);
  assert.equal(site.state.ocrDocuments.length, 1, "沒有狀態檔時不能製造第二份 OCR 文件");
  assert.match(noJournal.stderr, /需要 --state 狀態檔/);
  site.close();
});

/* ------------------------------------------------- OCR journal safety (scoped, v2) */

/** A database whose single OCR document really uploads, keyed `ocr:1|ocr/shot-1.png` in the journal. */
function ocrUploadFixture(name, extra = () => {}) {
  const dbPath = createSourceSqlite(name, (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addOcr(db, { objectKey: "ocr/shot-1.png", filename: "shot 1.png" });
    extra(db);
  });
  const imageDir = join(workDir, `${name}-images`);
  mkdirSync(join(imageDir, "ocr"), { recursive: true });
  writeFileSync(join(imageDir, "ocr", "shot-1.png"), PNG);
  return { dbPath, imageDir };
}

const ocrApplyArgs = ({ dbPath, site, statePath, imageDir, snapshots = false }) => [
  "--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target", "--ocr-image-dir", imageDir, "--state", statePath,
  ...(snapshots ? ["--with-snapshots"] : []),
];

test("a journal written for one target is refused by another, before any POST", async () => {
  const { dbPath, imageDir } = ocrUploadFixture("journal-target");
  const uploaded = createMockSite();
  const other = createMockSite();
  const statePath = join(workDir, "journal-target-state.json");

  const first = await runCli(ocrApplyArgs({ dbPath, site: uploaded, statePath, imageDir }));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(uploaded.state.ocrDocuments.length, 1);

  const reused = await runCli(ocrApplyArgs({ dbPath, site: other, statePath, imageDir }));
  assert.equal(reused.status, 2, `換目標應拒絕並且零個 POST：${reused.status}`);
  assert.deepEqual(other.requests.map(requestRecord), ["GET /api/portfolio"], "只有目標預檢的讀取送得出去");
  assert.deepEqual(postPaths(other), [], "目標不符時匯入與 OCR 都不能送");
  assert.deepEqual(other.state.imports, []);
  assert.equal(other.state.ocrDocuments.length, 0, "別的目標沒收過這份文件，不能當成已上傳而跳過");
  assert.match(reused.stderr, /JOURNAL_SCOPE_MISMATCH/);
  assert.match(reused.stderr, /狀態檔綁定的目標是/, "要說明狀態檔綁的是哪個目標");
  assert.ok(reused.stderr.includes(classifyTarget(uploaded.baseUrl).baseUrl), "拒絕的理由要點出舊記錄所屬的目標");
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).scope.targetBaseUrl, classifyTarget(uploaded.baseUrl).baseUrl, "拒絕時不得覆寫原狀態檔的綁定");
  uploaded.close();
  other.close();
});

test("a journal written for one source database is refused by another, before any POST", async () => {
  // Two different files, each with OCR id 1 and the same object key: exactly the collision the old
  // unscoped journal let one database inherit from another.
  const a = ocrUploadFixture("journal-source-a");
  const b = ocrUploadFixture("journal-source-b");
  const site = createMockSite();
  const statePath = join(workDir, "journal-source-state.json");

  const first = await runCli(ocrApplyArgs({ dbPath: a.dbPath, site, statePath, imageDir: a.imageDir }));
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(statePath, "utf8")).completed), ["ocr:1|ocr/shot-1.png"]);

  const before = site.requests.length;
  const reused = await runCli(ocrApplyArgs({ dbPath: b.dbPath, site, statePath, imageDir: b.imageDir }));
  assert.equal(reused.status, 2, `換來源資料庫應拒絕並且零個 POST：${reused.status}`);
  assert.deepEqual(site.requests.slice(before).map(requestRecord), ["GET /api/portfolio"]);
  assert.deepEqual(postsOf(site.requests.slice(before)), [], "另一份資料庫的文件不能沿用前一份的上傳記錄");
  assert.equal(site.state.ocrDocuments.length, 1, "第一次上傳的文件不受這輪影響");
  assert.equal(site.state.imports.length, 1, "新來源的匯入同樣不該送出去");
  assert.match(reused.stderr, /JOURNAL_SCOPE_MISMATCH/);
  assert.match(reused.stderr, /來源/);
  site.close();
});

test("a legacy unscoped v1 journal is refused instead of trusted or rewritten", async () => {
  const { dbPath, imageDir } = ocrUploadFixture("journal-legacy");
  const site = createMockSite();
  const statePath = join(workDir, "journal-legacy-state.json");
  const legacy = `${JSON.stringify({ version: 1, completed: { "ocr:1|ocr/shot-1.png": { at: "2026-08-24T02:00:00.000Z", serverDocumentId: 1 } } }, null, 2)}\n`;
  writeFileSync(statePath, legacy);

  const result = await runCli(ocrApplyArgs({ dbPath, site, statePath, imageDir }));
  assert.equal(result.status, 2, `舊格式應在任何寫入之前擋下：${result.status}／${result.stderr}`);
  assert.deepEqual(site.requests.map(requestRecord), ["GET /api/portfolio"]);
  assert.deepEqual(postPaths(site), [], "v1 狀態檔被拒時匯入與 OCR 都要零請求");
  assert.equal(site.state.ocrDocuments.length, 0, "不能拿無法判斷歸屬的記錄跳過上傳");
  assert.match(result.stderr, /JOURNAL_VERSION_UNSUPPORTED/);
  assert.equal(readFileSync(statePath, "utf8"), legacy, "擋下時旧檔要原封不動，讓操作者自己決定");
  site.close();
});

test("planned OCR with an unpersistable --state stops before import, snapshot and OCR POSTs", async () => {
  const { dbPath, imageDir } = ocrUploadFixture("journal-unwritable", (db) => {
    addSnapshot(db, "2026-08-24", { positionCount: 1, costBasisTwd: 2050, marketValueTwd: 2275, pnlTwd: 225, dividendTwd: 150 });
  });
  const site = createMockSite();
  const missingParent = join(workDir, "journal-missing-dir", "state.json");

  const gone = await runCli(ocrApplyArgs({ dbPath, site, statePath: missingParent, imageDir, snapshots: true }));
  assert.equal(gone.status, 2, `目錄不存在應在任何 POST 之前擋下：${gone.status}／${gone.stderr}`);
  assert.deepEqual(site.requests.map(requestRecord), ["GET /api/portfolio"], "只有預檢的讀取送得出去");
  assert.deepEqual(postPaths(site), [], "匯入、快照重建、OCR 上傳一個都不能送，否則這輪的結果無處可記");
  assert.deepEqual({ imports: site.state.imports.length, snapshots: site.state.snapshots.length, ocr: site.state.ocrDocuments.length }, { imports: 0, snapshots: 0, ocr: 0 });
  assert.match(gone.stderr, /JOURNAL_STATE_UNWRITABLE/);
  assert.equal(existsSync(missingParent), false, "預檢不得自己把缺席的目錄變出來");

  // W_OK is only a real gate for a non-root uid; root ignores the permission bits entirely.
  if (process.getuid?.() !== 0) {
    const readOnlyDir = join(workDir, "journal-readonly");
    mkdirSync(readOnlyDir);
    chmodSync(readOnlyDir, 0o500);
    try {
      const before = site.requests.length;
      const denied = await runCli(ocrApplyArgs({ dbPath, site, statePath: join(readOnlyDir, "state.json"), imageDir, snapshots: true }));
      assert.equal(denied.status, 2, `不可寫入的目錄應在任何 POST 之前擋下：${denied.status}／${denied.stderr}`);
      assert.deepEqual(site.requests.slice(before).map(requestRecord), ["GET /api/portfolio"]);
      assert.deepEqual(postsOf(site.requests.slice(before)), [], "不可寫狀態檔時同樣要零個 POST");
      assert.match(denied.stderr, /JOURNAL_STATE_UNWRITABLE/);
    } finally {
      chmodSync(readOnlyDir, 0o700);
    }
  }
  site.close();
});

test("the state journal is bound to target plus source, and stays 0600 across updates", async () => {
  const { dbPath, imageDir } = ocrUploadFixture("journal-mode");
  const site = createMockSite();
  const statePath = join(workDir, "journal-mode-state.json");
  const mode = () => statSync(statePath).mode & 0o777;

  const first = await runCli(ocrApplyArgs({ dbPath, site, statePath, imageDir }));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(mode(), 0o600, "新建的狀態檔不可群組或他人可讀");
  const journal = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(
    { journalVersion: journal.journalVersion, scope: journal.scope },
    { journalVersion: 2, scope: { targetBaseUrl: classifyTarget(site.baseUrl).baseUrl, sourceDatabase: resolve(dbPath) } },
    "跳過 OCR 的依據要寫明它是哪一組（目標＋來源）的記錄",
  );
  assert.deepEqual(Object.keys(journal.completed), ["ocr:1|ocr/shot-1.png"]);

  chmodSync(statePath, 0o644);
  const second = await runCli(ocrApplyArgs({ dbPath, site, statePath, imageDir }));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(mode(), 0o600, "更新狀態檔時要把權限壓回 0600");
  assert.equal(postPaths(site).filter((path) => path === "/api/ocr").length, 1, "同一（目標＋來源）的第二次執行照樣跳過，而不是重複上傳");
  assert.equal(site.state.ocrDocuments.length, 1);
  site.close();
});

test("applyPlan refuses a journal that is not bound to its own plan, without touching the client", async () => {
  const sent = [];
  const client = {
    postImport: async () => sent.push("/api/import"),
    postSnapshot: async () => sent.push("/api/snapshots"),
    postOcr: async () => sent.push("/api/ocr"),
  };
  const plan = {
    target: { baseUrl: "https://planned.example/base" },
    source: { database: "/data/planned.sqlite" },
    imports: [],
    snapshots: [],
    ocrDocuments: [{ status: "planned", localOcrId: 1, idempotencyKey: "ocr:1|ocr/shot-1.png" }],
  };
  for (const scope of [
    { targetBaseUrl: "https://other.example/base", sourceDatabase: "/data/planned.sqlite" },
    { targetBaseUrl: "https://planned.example/base", sourceDatabase: "/data/other.sqlite" },
    null,
  ]) {
    await assert.rejects(
      applyPlan({ plan, client, journal: { path: "/tmp/journal.json", version: 2, scope, completed: { "ocr:1|ocr/shot-1.png": { at: "2026-08-24T02:00:00.000Z", serverDocumentId: 1 } } } }),
      (error) => error.code === "JOURNAL_SCOPE_MISMATCH",
      `journal scope ${JSON.stringify(scope)} 不屬於這輪計畫`,
    );
  }
  assert.deepEqual(sent, [], "綁定不符時 applyPlan 一個請求都不該送");
});

test("snapshots are recreated from the date, after imports, in chronological order", async () => {
  const dbPath = createSourceSqlite("snapshots", (db) => {
    addImport(db, { filename: "stock-0831.csv", fileHash: HASH_A, sourceKind: "stock_csv", asOfDate: "2026-08-31", rows: [stockRow("中華電", 1300)] });
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_B, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    // Inserted newest first on purpose: the plan has to replay them oldest first.
    addSnapshot(db, "2026-08-31", { positionCount: 99, costBasisTwd: 1, marketValueTwd: 2, pnlTwd: 3, dividendTwd: 4 });
    addSnapshot(db, "2026-08-24", { positionCount: 99, costBasisTwd: 1, marketValueTwd: 2, pnlTwd: 3, dividendTwd: 4 });
  });
  const site = createMockSite();
  const summaryPath = join(workDir, "snapshot-summary.json");
  const { plan } = await planFor(dbPath, ["--with-snapshots"], { site });
  assert.deepEqual(plan.imports.map((item) => item.filename), ["fund-0824.csv", "stock-0831.csv"], "統計日期由舊到依序重放");
  assert.deepEqual(plan.snapshots.map((item) => item.snapshotDate), ["2026-08-24", "2026-08-31"]);
  assert.deepEqual(plan.snapshots.map((item) => item.status), ["planned", "planned"]);
  assert.deepEqual(plan.snapshots.map((item) => item.request.body), [{ snapshotDate: "2026-08-24" }, { snapshotDate: "2026-08-31" }], "只有日期會出發，金額由伺服器重算");
  assert.equal(plan.snapshots[0].matchesLocal, false, "本機快照與本機重算不符時要標出來");
  assert.equal(plan.snapshots[0].expectedTotals.marketValueTwd, 2275);
  assert.deepEqual(plan.snapshots[0].expectedImportsUsed, [{ filename: "fund-0824.csv", sourceKind: "fund_csv", asOfDate: "2026-08-24", rowCount: 1 }]);

  const applied = await runCli(["--db", dbPath, "--site", site.baseUrl, "--with-snapshots", "--apply", "--allow-local-target", "--summary-json", summaryPath]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(postPaths(site), ["/api/import", "/api/import", "/api/snapshots", "/api/snapshots"]);
  assert.deepEqual(site.state.snapshots.map((item) => item.snapshotDate), ["2026-08-24", "2026-08-31"]);
  assert.deepEqual(site.state.snapshots.map((item) => item.totals.marketValueTwd), [2275, 3575], "快照數字來自匯入後的伺服器資料，不是本機行");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.deepEqual(summary.results.snapshots.map((item) => item.outcome), ["created", "created"]);
  assert.deepEqual(summary.results.snapshots.map((item) => item.serverTotals.positionCount), [1, 2]);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.totals.snapshotsPlanned, 2);
  site.close();
});

test("a replayed apply treats HTTP 409 as idempotent success", async () => {
  const dbPath = createSourceSqlite("replay", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addSnapshot(db, "2026-08-24", { positionCount: 1, costBasisTwd: 2050, marketValueTwd: 2275, pnlTwd: 225, dividendTwd: 150 });
  });
  const site = createMockSite();
  const args = ["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target", "--with-snapshots"];

  const first = await runCli(args);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(postPaths(site), ["/api/import", "/api/snapshots"]);
  assert.match(first.stdout, /已套用/);

  const second = await runCli(args);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /早已套用（409，冪等成功）/);
  assert.match(second.stdout, /已存在（409，冪等成功）/);
  assert.match(second.stdout, /驗證通過/);
  assert.equal(site.state.imports.length, 1, "重複執行不能產生第二個批次");
  assert.equal(site.state.positions.length, 1, "重複執行不能重複插持倉");
  assert.equal(site.state.snapshots.length, 1, "重複執行不能重複插快照");
  site.close();
});

test("an interrupted batch is resumed from the server's pending row instead of duplicated", async () => {
  const dbPath = createSourceSqlite("resume", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const site = createMockSite();
  const args = ["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target"];
  site.crashOnNextImport();

  const interrupted = await runCli(args);
  assert.equal(interrupted.status, 3, interrupted.stderr);
  assert.deepEqual(site.state.imports.map((item) => [item.filename, item.status, item.rowCount]), [["fund-0824.csv", "pending", 0]], "被打斷的批次只剩沒有持倉的 pending 列");
  assert.equal(site.state.positions.length, 0);

  const resumed = await runCli(args);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(site.state.imports.length, 1, "route 沿用同一冪等鍵的 pending 列，不能留下第二列");
  assert.equal(site.state.positions.length, 1, "補完時不能把持倉再插一次");
  assert.deepEqual(site.state.imports.map((item) => [item.status, item.rowCount]), [["applied", 1]]);
  site.close();
});

test("a transient 5xx is retried and the import still lands exactly once", async () => {
  const dbPath = createSourceSqlite("flaky", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const site = createMockSite();
  site.failOnce("/api/import", 503, { error: "upstream busy" });

  const result = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(postPaths(site).filter((path) => path === "/api/import").length, 2, "第一次 503、第二次成功");
  assert.deepEqual(site.state.positions.map((position) => position.marketValueTwd), [2275], "重試不能留下重複持倉");
  assert.match(result.stdout, /已套用/);
  site.close();
});

test("a rejected import fails the run and stops snapshot recreation", async () => {
  const dbPath = createSourceSqlite("rejected", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addSnapshot(db, "2026-08-24");
  });
  const site = createMockSite();
  site.failOnce("/api/import", 400, { error: "匯入資訊不完整" });
  const summaryPath = join(workDir, "rejected-summary.json");

  const result = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target", "--with-snapshots", "--summary-json", summaryPath]);
  assert.equal(result.status, 3, `預期 exit 3，得到 ${result.status}：${result.stderr}`);
  assert.match(result.stdout, /import 失敗 id=1 fund_csv\/2026-08-24 HTTP 400：匯入資訊不完整/);
  assert.deepEqual(postPaths(site), ["/api/import"], "匯入失敗後不能再建快照，否則數字會以半份資料固定下來");
  assert.equal(site.state.snapshots.length, 0);
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.deepEqual(summary.failures, [{ stage: "import", localImportId: 1, filename: "fund-0824.csv", sourceKind: "fund_csv", asOfDate: "2026-08-24", fileHash: HASH_A, outcome: "failed", httpStatus: 400, error: "匯入資訊不完整" }]);
  assert.deepEqual(summary.results.snapshots, []);
  site.close();
});

test("verification mismatch exits nonzero and names the differing date", async () => {
  const dbPath = createSourceSqlite("mismatch", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const site = createMockSite();
  site.tamper = (json) => (json.asOfDate ? { ...json, totals: { ...json.totals, marketValueTwd: json.totals.marketValueTwd + 500 } } : json);
  const summaryPath = join(workDir, "mismatch-summary.json");

  const result = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target", "--summary-json", summaryPath]);
  assert.equal(result.status, 4, `預期 exit 4，得到 ${result.status}：${result.stderr}`);
  assert.match(result.stdout, /驗證不符/);
  assert.match(result.stdout, /marketValueTwd: 預期 2275，實際 2775/);
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.equal(summary.exitCode, 4);
  assert.equal(summary.verification.ok, false);
  assert.equal(summary.verification.checks.find((check) => check.id === "asOf:2026-08-24").ok, false);
  assert.equal(summary.requestsSent.imports, 1, "匯入其實成功了，失敗的是回讀核對");
  assert.deepEqual(summary.notVerifiable.map((item) => item.field).sort(), ["imports.created_at", "ocr_documents", "portfolio_snapshots", "positions.raw_json"]);
  assert.deepEqual({ exact: summary.verification.ocr.exactVerification, uploaded: summary.verification.ocr.uploaded }, { exact: "unsupported", uploaded: 0 });
  site.close();
});

test("a date the server never learned about fails verification instead of passing silently", async () => {
  const dbPath = createSourceSqlite("missing-date", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const site = createMockSite();
  site.tamper = (json) => (json.asOfDate ? json : { ...json, availableDates: [] });
  const result = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target"]);
  assert.equal(result.status, 4, `預期 exit 4，得到 ${result.status}：${result.stderr}`);
  assert.match(result.stdout, /availableDates 缺少：2026-08-24/);
  site.close();
});

test("--apply 預檢：Version-2 形狀的 200 會被擋下，一個 POST 都不送", async () => {
  const dbPath = createSourceSqlite("preflight-v2", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addSnapshot(db, "2026-08-24", { positionCount: 1, costBasisTwd: 2050, marketValueTwd: 2275, pnlTwd: 225, dividendTwd: 150 });
  });
  const site = createMockSite();
  site.tamper = versionTwoPortfolio;

  const result = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target", "--with-snapshots"]);
  assert.equal(result.status, 2, `預期 exit 2，得到 ${result.status}：${result.stderr}`);
  assert.deepEqual(site.requests.map(requestRecord), ["GET /api/portfolio"], "預檢是這輪唯一送出的請求");
  assert.deepEqual(postPaths(site), [], "Version-2 遠端一個寫入請求都不能收到");
  assert.match(result.stderr, /TARGET_VERSION_UNSUPPORTED/);
  assert.match(result.stderr, /totals 應為非 null 物件，實際是 undefined/);
  assert.match(result.stderr, /importsUsed 應為陣列，實際是 undefined/);
  assert.match(result.stderr, /availableDates 應為陣列，實際是 undefined/);
  assert.deepEqual(site.state.imports, [], "遠端資料庫不會被半套寫進去");
  assert.deepEqual(site.state.snapshots, []);
  site.close();
});

test("--apply 預檢：200 但三個欄位任一形狀不對，同樣零個 POST", async () => {
  const dbPath = createSourceSqlite("preflight-shape", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const variants = [
    ["totals 是 null", (json) => ({ ...json, totals: null }), /totals 應為非 null 物件，實際是 null/],
    ["importsUsed 是物件", (json) => ({ ...json, importsUsed: {} }), /importsUsed 應為陣列，實際是 object/],
    ["availableDates 是字串", (json) => ({ ...json, availableDates: "2026-08-24" }), /availableDates 應為陣列，實際是 string/],
  ];
  for (const [label, tamper, expected] of variants) {
    const site = createMockSite();
    site.tamper = tamper;
    const result = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target"]);
    assert.equal(result.status, 2, `${label}：預期 exit 2，得到 ${result.status}：${result.stderr}`);
    assert.deepEqual(postPaths(site), [], `${label}：形狀不對就不能寫`);
    assert.match(result.stderr, expected, label);
    assert.deepEqual(site.state.imports, [], `${label}：遠端保持原樣`);
    site.close();
  }
});

test("--apply 預檢：401 擋在任何寫入之前；標頭對了同一站就讓這輪走完", async () => {
  const dbPath = createSourceSqlite("preflight-401", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const token = "bearer-token-for-the-preflight-test";
  const site = createMockSite().requireHeader("authorization");
  const args = ["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target"];

  const blocked = await runCli(args);
  assert.equal(blocked.status, 2, `預期 exit 2，得到 ${blocked.status}：${blocked.stderr}`);
  assert.deepEqual(site.requests.map(requestRecord), ["GET /api/portfolio"], "沒有認證時只讀得進來這一次");
  assert.deepEqual(postPaths(site), [], "401 之後一個寫入請求都不該送");
  assert.match(blocked.stderr, /TARGET_VERSION_UNSUPPORTED/);
  assert.match(blocked.stderr, /HTTP 401/);
  assert.match(blocked.stderr, /--header／SITES_SYNC_HEADERS/);
  assert.deepEqual(site.state.imports, []);

  const before = site.requests.length;
  const allowed = await runCli([...args, "--header", `authorization:Bearer ${token}`]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(site.requests.slice(before).map(requestRecord), [
    "GET /api/portfolio",
    "POST /api/import",
    "GET /api/portfolio",
    "GET /api/portfolio",
  ], "Version-3 遠端要通過預檢，照常完成匯入與回讀核對");
  for (const request of site.requests.slice(before)) {
    assert.equal(request.headers.authorization, `Bearer ${token}`, "預檢與寫入共用同一組認證標頭");
  }
  assert.equal(site.state.imports.length, 1);
  site.close();
});

test("--apply refuses localhost and private targets without an explicit opt-in", async () => {
  const dbPath = createSourceSqlite("target", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const site = createMockSite();
  const refused = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--allow-local-target/);
  assert.equal(site.requests.length, 0);

  for (const host of ["http://localhost:8787", "http://10.1.2.3", "http://192.168.4.5:3000", "http://172.20.3.4", "http://[::1]:8080", "http://[fd00::1]:8080", "http://terminal.local", "http://intranetbox", "https://127.0.0.1"]) {
    assert.equal(classifyTarget(host).environment, "local", `${host} 應該被視為本機／内網`);
  }
  for (const host of ["https://my-site.example.com", "https://sites.chatgpt.com/appgprj_6a9447e96cdc8191a057ea8ce95995a5"]) {
    assert.equal(classifyTarget(host).environment, "production", `${host} 應該是正式站`);
  }
  assert.equal(classifyTarget("https://sites.example.com/base/").baseUrl, "https://sites.example.com/base");
  assert.throws(() => classifyTarget("not a url"), /不是合法的 URL/);
  assert.throws(() => classifyTarget("ftp://example.com"), /只支援 http/);

  const allowed = await runCli(["--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(postPaths(site), ["/api/import"]);
  site.close();
});

test("a production target warns loudly and is the only place --apply goes by default", async () => {
  const dbPath = createSourceSqlite("prod-note", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
    addSnapshot(db, "2026-08-24", { positionCount: 1, costBasisTwd: 2050, marketValueTwd: 2275, pnlTwd: 225, dividendTwd: 150 });
  });
  const site = createMockSite();
  const cli = await import("../scripts/sync-sqlite-to-sites.mjs");
  const seen = [];
  const lines = [];
  // No test may reach a real host: the stub keeps the production origin in the CLI's own URL
  // handling but redirects the bytes to the loopback mock.
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    seen.push(`${parsed.origin}${parsed.pathname}${parsed.search}`);
    const response = await fetch(`${site.baseUrl}${parsed.pathname}${parsed.search}`, init);
    return new Response(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
  };

  const code = await cli.main(["--db", dbPath, "--site", "https://site.example.com", "--apply", "--with-snapshots"], {
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    env: {},
    fetchImpl,
  });
  const output = lines.join("\n");
  assert.equal(code, 0, output);
  assert.match(output, /即將寫入【正式站】 https:\/\/site\.example\.com/);
  assert.match(output, /1 個 \/api\/import 請求、1 筆持倉/);
  assert.match(output, /D1（imports\/positions\/portfolio_snapshots）/);
  assert.match(output, /驗證通過/);
  assert.deepEqual(seen, [
    "https://site.example.com/api/portfolio",
    "https://site.example.com/api/import",
    "https://site.example.com/api/snapshots",
    "https://site.example.com/api/portfolio",
    "https://site.example.com/api/portfolio?asOf=2026-08-24",
  ], "任何寫入之前都要先預檢遠端的 /api/portfolio");
  const importRequest = site.requests.find((request) => request.path === "/api/import");
  assert.deepEqual(JSON.parse(importRequest.raw.toString("utf8")).asOfDate, "2026-08-24");
  assert.deepEqual(site.state.snapshots.map((item) => [item.snapshotDate, item.totals.marketValueTwd]), [["2026-08-24", 2275]]);
  site.close();
});

test("header values never reach stdout, stderr, the plan or the summary", async () => {
  const dbPath = createSourceSqlite("secrets", (db) => {
    addImport(db, { filename: "fund-0824.csv", fileHash: HASH_A, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
  });
  const site = createMockSite();
  const secret = "sup3r-s3cret-token-value";
  const planPath = join(workDir, "secret-plan.json");
  const summaryPath = join(workDir, "secret-summary.json");
  const statePath = join(workDir, "secret-state.json");
  const result = await runCli([
    "--db", dbPath, "--site", site.baseUrl, "--apply", "--allow-local-target",
    "--header", `oai-authenticated-user-email:${secret}`, "--plan-json", planPath, "--summary-json", summaryPath, "--state", statePath,
  ], { env: { SITES_SYNC_HEADERS: JSON.stringify({ authorization: `Bearer ${secret}` }) } });

  assert.equal(result.status, 0, result.stderr);
  const portfolioRequest = site.requests.find((request) => request.path === "/api/portfolio");
  assert.equal(portfolioRequest.headers["oai-authenticated-user-email"], secret, "標頭確實送到了部署站");
  assert.equal(portfolioRequest.headers.authorization, `Bearer ${secret}`);
  for (const text of [result.stdout, result.stderr, readFileSync(planPath, "utf8"), readFileSync(summaryPath, "utf8"), readFileSync(statePath, "utf8")]) {
    assert.equal(text.includes(secret), false, "秘密值不可出現在任何輸出");
  }
  // Names only, in override order: the environment map is applied first, then --header on top.
  assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")).authHeaders, ["authorization", "oai-authenticated-user-email"]);
  assert.deepEqual(JSON.parse(readFileSync(summaryPath, "utf8")).authHeaderNames, ["authorization", "oai-authenticated-user-email"]);
  site.close();
});

test("an unreadable or pre-0002 source database fails closed with the migration named", async () => {
  const legacy = join(workDir, "legacy.sqlite");
  const db = new DatabaseSync(legacy);
  migrate(db, "0000_sudden_punisher.sql", "0001_living_miss_america.sql");
  db.close();
  const site = createMockSite();
  const result = await runCli(["--db", legacy, "--site", site.baseUrl]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /SOURCE_SCHEMA_MISMATCH/);
  assert.match(result.stderr, /imports 缺少欄位 as_of_date（需要 drizzle\/0002_as_of_import_status\.sql）/);
  assert.equal(site.requests.length, 0);

  const missingPath = join(workDir, "does-not-exist.sqlite");
  const missing = await runCli(["--db", missingPath, "--site", site.baseUrl]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /SOURCE_UNREADABLE/);

  const badArgs = await runCli(["--db", missingPath]);
  assert.equal(badArgs.status, 2);
  assert.match(badArgs.stderr, /需要 --site/);
  const unknown = await runCli(["--db", legacy, "--site", site.baseUrl, "--no-such-flag"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知參數：--no-such-flag/);
  const positional = await runCli(["--db", legacy, "--site", site.baseUrl, "apply"]);
  assert.equal(positional.status, 2);
  assert.match(positional.stderr, /只認識 -- 開頭的參數/);
  site.close();
});

test("batches the API cannot accept are blocked, not silently repaired", async () => {
  const dbPath = createSourceSqlite("blocked", (db) => {
    addImport(db, { filename: "no-date.csv", fileHash: HASH_A, sourceKind: "stock_csv", asOfDate: null, rows: [stockRow("中華電", 1200)] });
    addImport(db, { filename: "bad-hash.csv", fileHash: "  ", sourceKind: "stock_csv", asOfDate: "2026-08-25", rows: [stockRow("中華電", 1200)] });
    addImport(db, { filename: "count.csv", fileHash: HASH_B, sourceKind: "fund_csv", asOfDate: "2026-08-26", rows: [fundRow()] });
    db.prepare("UPDATE imports SET row_count = 7 WHERE filename = 'count.csv'").run();
    addImport(db, { filename: "parser.csv", fileHash: hashOf("parser"), sourceKind: "ins_csv", asOfDate: "2026-08-27", parserVersion: 2, rows: [fundRow("新標的")] });
    addImport(db, { filename: "broken-raw.csv", fileHash: hashOf("raw"), sourceKind: "csv_broken", asOfDate: "2026-08-28", rows: [fundRow("壞資料")] });
    db.prepare("UPDATE positions SET raw_json = 'not json' WHERE asset_name = '壞資料'").run();
    addImport(db, { filename: "broken-number.csv", fileHash: hashOf("num"), sourceKind: "csv_num", asOfDate: "2026-08-29", rows: [fundRow("數字壞了")] });
    db.prepare("UPDATE positions SET market_value_twd = 'N/A' WHERE asset_name = '數字壞了'").run();
    addImport(db, { filename: "bad-date.csv", fileHash: hashOf("baddate"), sourceKind: "csv_date", asOfDate: "2026-02-30", rows: [fundRow("日期不存在")] });
    addImport(db, { filename: "empty-name.csv", fileHash: hashOf("emptyname"), sourceKind: "csv_name", asOfDate: "2026-08-30", rows: [stockRow("   ", 100)] });
  });
  const { plan } = await planFor(dbPath);
  const codes = Object.fromEntries(plan.imports.map((item) => [item.filename, item.code]));
  assert.deepEqual(codes, {
    "no-date.csv": "IMPORT_MISSING_AS_OF_DATE",
    "bad-hash.csv": "IMPORT_IDENTITY_INCOMPLETE",
    "bad-date.csv": "IMPORT_INVALID_AS_OF_DATE",
    "broken-raw.csv": "IMPORT_ROW_INVALID",
    "broken-number.csv": "IMPORT_ROW_INVALID",
    "empty-name.csv": "IMPORT_ROW_INVALID",
    "count.csv": "IMPORT_ROW_COUNT_MISMATCH",
    "parser.csv": "IMPORT_PARSER_VERSION_UNSUPPORTED",
  });
  assert.match(plan.imports.find((item) => item.filename === "no-date.csv").reasons.join(" "), /台北當日日期/);
  assert.match(plan.imports.find((item) => item.filename === "broken-number.csv").reasons.join(" "), /market_value_twd|marketValueTwd 不是有限數值/);
  assert.deepEqual(plan.dates, []);
  assert.equal(plan.totals.imports, 0);
});

test("the CLI's as-of expectation matches lib/portfolio.ts on the same data", async () => {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
  try {
    const { getPortfolioAsOf } = await vite.ssrLoadModule("/lib/portfolio.ts");
    const dbPath = createSourceSqlite("parity", (db) => {
      addImport(db, { filename: "stock-0824.csv", fileHash: HASH_A, sourceKind: "stock_csv", asOfDate: "2026-08-24", rows: [stockRow("中華電", 100, { costBasisTwd: 90, pnlTwd: 10 })] });
      addImport(db, { filename: "fund-0824.csv", fileHash: HASH_B, sourceKind: "fund_csv", asOfDate: "2026-08-24", rows: [fundRow()] });
      addImport(db, { filename: "stock-0831.csv", fileHash: hashOf("3"), sourceKind: "stock_csv", asOfDate: "2026-08-31", rows: [stockRow("中華電", 1300, { costBasisTwd: 90, pnlTwd: 30 })] });
      addImport(db, { filename: "draft-0907.csv", fileHash: hashOf("4"), sourceKind: "fund_csv", asOfDate: "2026-09-07", status: "pending", rows: [fundRow("草稿")] });
    });
    const sqlite = new DatabaseSync(dbPath, { readOnly: true });
    const asD1 = {
      prepare(query) {
        const statement = sqlite.prepare(query);
        const wrap = (values) => ({ all: async () => ({ results: statement.all(...values) }), first: async () => statement.all(...values)[0] ?? null });
        return { bind: (...values) => wrap(values), all: () => wrap([]).all, first: () => wrap([]).first };
      },
    };
    for (const date of [null, "2026-08-23", "2026-08-24", "2026-08-31", "2026-09-07"]) {
      const expected = await getPortfolioAsOf(asD1, date);
      const actual = expectedPortfolioAsOf(sqlite, date);
      assert.deepEqual(actual.totals, expected.totals, `${date} 的金額必須與 app 一致`);
      assert.equal(actual.dataAsOf, expected.dataAsOf);
      assert.deepEqual(
        actual.importsUsed.map((item) => [item.filename, item.sourceKind, item.asOfDate, item.rowCount]),
        expected.importsUsed.map((item) => [item.filename, item.sourceKind, item.asOfDate, item.rowCount]),
      );
    }
    sqlite.close();
  } finally {
    await vite.close();
  }
});

function hashOf(value) {
  return createHash("sha256").update(value).digest("hex");
}
