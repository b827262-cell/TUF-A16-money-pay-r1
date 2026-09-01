/**
 * Apply + verify. Reached only after --apply, so nothing in here runs during a dry-run.
 *
 * Imports and snapshots lean on the server's own idempotency keys ((fileHash, sourceKind, asOfDate)
 * and snapshot_date) and treat HTTP 409 as success, which makes a rerun safe without any local state.
 * app/api/ocr/route.ts has no such key, so OCR is the one stage that needs the local journal to avoid
 * uploading the same document twice — which in turn means the journal is only meaningful for the exact
 * (target, source database) pairing that wrote it, and only if it can actually be persisted.
 */
import { accessSync, chmodSync, constants as fsConstants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SyncError, expectedPortfolioAsOf } from "./sqlite-source.mjs";
import { closeEnough, AVAILABLE_DATES_WINDOW } from "./plan.mjs";

const JOURNAL_VERSION = 2;
// The journal names documents, ids and the deployed origin, and it is the only thing standing between
// a rerun and a duplicate OCR document, so it never goes out group- or world-readable.
const JOURNAL_FILE_MODE = 0o600;
const PORTFOLIO_PATH = "/api/portfolio";
const TOTAL_KEYS = ["positionCount", "costBasisTwd", "marketValueTwd", "pnlTwd", "dividendTwd"];

/**
 * The pairing a journal is allowed to speak for. OCR keys are made of local autoincrement ids, so
 * without this binding the same file reused on another site (or for another database) would claim
 * documents that target never received and skip them silently.
 */
export function journalScope({ target, databasePath }) {
  return { targetBaseUrl: target.baseUrl, sourceDatabase: resolve(databasePath) };
}

export function readJournal(path, scope) {
  if (!path) return { path: null, version: JOURNAL_VERSION, scope, completed: {} };
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { path: absolute, version: JOURNAL_VERSION, scope, completed: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new SyncError("JOURNAL_UNREADABLE", `無法解析狀態檔 ${absolute}：${error instanceof Error ? error.message : error}`);
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.completed)) {
    throw new SyncError("JOURNAL_UNREADABLE", `狀態檔 ${absolute} 不是 sync-sqlite-to-sites 的格式，拒絕猜它記錄了什麼`);
  }
  for (const [key, value] of Object.entries(parsed.completed)) {
    if (!isPlainObject(value)) {
      throw new SyncError("JOURNAL_UNREADABLE", `狀態檔 ${absolute} 的 completed.${key} 不是物件，拒絕猜它記錄了什麼`);
    }
  }
  if (parsed.journalVersion !== JOURNAL_VERSION) {
    throw new SyncError(
      "JOURNAL_VERSION_UNSUPPORTED",
      `狀態檔 ${absolute} 的版本是 ${String(parsed.journalVersion ?? parsed.version ?? "（無版本）")}，v${JOURNAL_VERSION} 之前的格式沒有綁定目標與來源，無法判斷那些記錄屬於哪個站點，因此一概不信任。已停止在任何寫入請求之前：請換一個新的 --state 路徑，舊檔請自行留存或刪除。`,
    );
  }
  const stored = parsed.scope;
  if (!isPlainObject(stored) || typeof stored.targetBaseUrl !== "string" || typeof stored.sourceDatabase !== "string") {
    throw new SyncError("JOURNAL_SCOPE_MISMATCH", `狀態檔 ${absolute} 是 v${JOURNAL_VERSION} 卻沒有目標／來源綁定（scope），拒絕用它跳過 ${Object.keys(parsed.completed).length} 筆 OCR 上傳`);
  }
  const mismatches = [];
  if (stored.targetBaseUrl !== scope.targetBaseUrl) mismatches.push(`狀態檔綁定的目標是 ${stored.targetBaseUrl}，這一輪要寫入 ${scope.targetBaseUrl}`);
  if (stored.sourceDatabase !== scope.sourceDatabase) mismatches.push(`狀態檔綁定的來源是 ${stored.sourceDatabase}，這一輪讀的是 ${scope.sourceDatabase}`);
  if (mismatches.length) {
    throw new SyncError(
      "JOURNAL_SCOPE_MISMATCH",
      `狀態檔 ${absolute} 不是這一輪（目標＋來源）的狀態，拒絕用它跳過 OCR：\n  - ${mismatches.join("\n  - ")}\n已停止在任何寫入請求之前：請換一個新的 --state 路徑（或先把舊檔留給原本的目標／來源）。`,
    );
  }
  return {
    path: absolute,
    version: JOURNAL_VERSION,
    scope: { targetBaseUrl: stored.targetBaseUrl, sourceDatabase: stored.sourceDatabase },
    completed: parsed.completed,
  };
}

/**
 * Proves the journal can be persisted while the run still has sent no write at all.
 *
 * The journal is written immediately after each successful /api/ocr response, so a path that cannot
 * be created means every upload of this run would be unrecorded — and /api/ocr has no idempotency
 * key, so the rerun would append a second document. Better to send nothing.
 */
export function assertJournalWritable(journal, { log = () => {} } = {}) {
  const parent = dirname(journal.path);
  if (!existsSync(parent)) {
    throw new SyncError("JOURNAL_STATE_UNWRITABLE", `狀態檔的目錄不存在：${parent}。已停止在任何寫入請求之前，請先建立該目錄或換一個 --state 路徑。`);
  }
  try {
    accessSync(parent, fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    throw new SyncError("JOURNAL_STATE_UNWRITABLE", `狀態檔的目錄 ${parent} 不可寫入：${error instanceof Error ? error.message : error}。已停止在任何寫入請求之前。`);
  }
  try {
    persistJournal(journal);
  } catch (error) {
    throw new SyncError("JOURNAL_STATE_UNWRITABLE", `狀態檔 ${journal.path} 不可建立或不可寫入：${error instanceof Error ? error.message : error}。已停止在任何寫入請求之前。`);
  }
  log(`狀態檔預檢通過：${journal.path}`);
}

export function writeJournal(journal) {
  if (!journal.path) return;
  try {
    persistJournal(journal);
  } catch (error) {
    throw new SyncError(
      "JOURNAL_STATE_WRITE_FAILED",
      `狀態檔 ${journal.path} 寫不下去：${error instanceof Error ? error.message : error}。OCR 上傳結果無處可記，不得再送出任何 /api/ocr；請先修復這個路徑再重跑。`,
    );
  }
}

function persistJournal(journal) {
  const text = `${JSON.stringify({ journalVersion: JOURNAL_VERSION, scope: journal.scope, completed: journal.completed }, null, 2)}\n`;
  writeFileSync(journal.path, text, { mode: JOURNAL_FILE_MODE });
  // writeFileSync only applies mode when it creates the file, so an existing journal is re-pinned.
  chmodSync(journal.path, JOURNAL_FILE_MODE);
}

/** The journal may only stand in for the exact (target, source) pairing it was written for. */
function assertJournalMatchesPlan(journal, plan) {
  const expected = { targetBaseUrl: plan.target?.baseUrl ?? null, sourceDatabase: plan.source?.database ?? null };
  const bound = journal.scope ?? {};
  if (bound.targetBaseUrl === expected.targetBaseUrl && bound.sourceDatabase === expected.sourceDatabase) return;
  throw new SyncError(
    "JOURNAL_SCOPE_MISMATCH",
    `狀態檔 ${journal.path} 綁定的是「${String(bound.targetBaseUrl)}／${String(bound.sourceDatabase)}」，與這輪的計畫「${String(expected.targetBaseUrl)}／${String(expected.sourceDatabase)}」不符，拒絕用它跳過 OCR。已停止在任何寫入請求之前。`,
  );
}

/**
 * Version-3 gate, reached before the first write of an --apply run.
 *
 * A pre-0002 deployment answers GET /api/portfolio with the raw V2 rows (positions/imports/
 * ocrDocuments/snapshots) and no as-of totals at all, so both the per-source_kind ranking the
 * imports lean on and the verification read below would be meaningless. The probe goes through the
 * same client, hence the same auth headers, and runs while the request log is still empty, so a
 * remote that fails it has been read and nothing more.
 */
export async function preflightTarget({ client, log = () => {} }) {
  const probe = await client.getPortfolio(null);
  if (probe.outcome !== "ok") {
    const authHint = probe.httpStatus === 401 || probe.httpStatus === 403 ? "（沒有通過部署站的認證，請確認 --header／SITES_SYNC_HEADERS）" : "";
    throw new SyncError(
      "TARGET_VERSION_UNSUPPORTED",
      `預檢失敗：GET ${PORTFOLIO_PATH} 回 HTTP ${probe.httpStatus} ${probe.error}${authHint}。已停止，未送出任何寫入請求。`,
      { httpStatus: probe.httpStatus },
    );
  }
  const payload = probe.portfolio;
  const problems = [];
  if (!isPlainObject(payload?.totals)) problems.push(`totals 應為非 null 物件，實際是 ${shapeOf(payload?.totals)}`);
  if (!Array.isArray(payload?.importsUsed)) problems.push(`importsUsed 應為陣列，實際是 ${shapeOf(payload?.importsUsed)}`);
  if (!Array.isArray(payload?.availableDates)) problems.push(`availableDates 應為陣列，實際是 ${shapeOf(payload?.availableDates)}`);
  if (problems.length) {
    throw new SyncError(
      "TARGET_VERSION_UNSUPPORTED",
      `預檢失敗：部署站的 GET ${PORTFOLIO_PATH} 回 HTTP 200，但形狀不是 Version-3（這代表遠端還沒跑 drizzle/0002，它的 as-of 排名與核對都不存在）：\n  - ${problems.join("\n  - ")}\n已停止，未送出任何寫入請求。`,
      { problems },
    );
  }
  log(`預檢通過：GET ${PORTFOLIO_PATH} 回 HTTP 200，形狀為 Version-3`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export async function applyPlan({ plan, client, journal, log = () => {} }) {
  // Checked before the first request: a journal bound to another pairing would both skip the wrong
  // documents here and leave this run's uploads unrecorded.
  if (journal.path && countPlanned(plan.ocrDocuments)) assertJournalMatchesPlan(journal, plan);
  const results = { imports: [], snapshots: [], ocr: [] };
  const failures = [];

  for (const item of plan.imports) {
    if (item.status !== "planned") continue;
    const label = `import id=${item.localImportId} ${item.sourceKind}/${item.asOfDate}`;
    log(`POST /api/import ${label} (${item.request.body.rows.length} 筆)`);
    const response = await client.postImport(item.request.body);
    if (response.outcome === "applied" || response.outcome === "already_applied") {
      results.imports.push({ ...identityOf(item), outcome: response.outcome, serverImportId: response.serverImportId, positionCount: item.positionCount });
    } else {
      failures.push({ stage: "import", ...identityOf(item), outcome: "failed", httpStatus: response.httpStatus, error: response.error });
      log(`! ${label} 失敗：HTTP ${response.httpStatus} ${response.error}`);
    }
  }

  // A snapshot is permanent per date and /api/ocr cannot be deduped by the server, so both stages
  // only run while nothing has failed earlier: stop, report, and let the operator rerun.
  if (!failures.length) await runSnapshots();
  if (!failures.length) await runOcr();
  if (failures.length) {
    const skippedSnapshots = countPlanned(plan.snapshots);
    const skippedOcr = countPlanned(plan.ocrDocuments);
    results.deferred = { reason: "EARLIER_STAGE_FAILED", snapshots: skippedSnapshots, ocr: skippedOcr };
    log(`! 因先前已有失敗，跳過 ${skippedSnapshots} 個快照重建與 ${skippedOcr} 筆 OCR 上傳`);
  }

  return { results, failures };

  async function runSnapshots() {
    for (const item of plan.snapshots) {
      if (item.status !== "planned") continue;
      const label = `snapshot ${item.snapshotDate}`;
      log(`POST /api/snapshots ${label}`);
      const response = await client.postSnapshot(item.request.body.snapshotDate);
      if (response.outcome === "created" || response.outcome === "already_exists") {
        results.snapshots.push({ snapshotDate: item.snapshotDate, outcome: response.outcome, serverSnapshotId: response.snapshot?.id ?? null, serverTotals: response.snapshot?.totals ?? null });
      } else {
        failures.push({ stage: "snapshot", snapshotDate: item.snapshotDate, outcome: "failed", httpStatus: response.httpStatus, error: response.error });
        log(`! ${label} 失敗：HTTP ${response.httpStatus} ${response.error}`);
      }
    }
  }

  async function runOcr() {
    for (const item of plan.ocrDocuments) {
      if (item.status !== "planned") continue;
      if (journal.completed[item.idempotencyKey]) {
        results.ocr.push({ localOcrId: item.localOcrId, outcome: "already_uploaded_from_journal", serverDocumentId: journal.completed[item.idempotencyKey].serverDocumentId ?? null });
        continue;
      }
      if (!journal.path) {
        // /api/ocr appends a row and an R2 object on every call, so a rerun without a journal duplicates it.
        results.ocr.push({ localOcrId: item.localOcrId, outcome: "skipped", code: "OCR_STATE_JOURNAL_REQUIRED" });
        log(`! OCR id=${item.localOcrId} 需要 --state 狀態檔才能上傳（/api/ocr 沒有冪等鍵）`);
        continue;
      }
      log(`POST /api/ocr id=${item.localOcrId} ${item.filename}`);
      let response;
      try {
        response = await client.postOcr({ form: buildOcrForm(item) });
      } catch (error) {
        // The request may already have landed; record nothing so the operator decides instead of duplicating.
        failures.push({ stage: "ocr", localOcrId: item.localOcrId, outcome: "unknown", error: error instanceof Error ? error.message : String(error) });
        log(`! OCR id=${item.localOcrId} 傳輸狀態不明，未記入狀態檔：${error instanceof Error ? error.message : error}`);
        continue;
      }
      if (response.outcome === "uploaded") {
        journal.completed[item.idempotencyKey] = { at: new Date().toISOString(), serverDocumentId: response.serverDocumentId };
        writeJournal(journal);
        results.ocr.push({ localOcrId: item.localOcrId, outcome: "uploaded", serverDocumentId: response.serverDocumentId });
      } else {
        failures.push({ stage: "ocr", localOcrId: item.localOcrId, outcome: "failed", httpStatus: response.httpStatus, error: response.error });
        log(`! OCR id=${item.localOcrId} 失敗：HTTP ${response.httpStatus} ${response.error}`);
      }
    }
  }
}

export function buildOcrForm(item) {
  const form = new FormData();
  const buffer = readFileSync(item.request.multipart.file.path);
  form.set("file", new File([buffer], item.request.multipart.file.filename, { type: item.image.contentType }));
  for (const [field, value] of Object.entries(item.request.multipart.fields)) form.set(field, value);
  return form;
}

/**
 * GET /api/portfolio is the only read the deployed site offers, so verification compares what it
 * actually exposes: per-date totals plus the imports behind them, and the applied-date list.
 */
export async function verifyPlan({ db, plan, client, results, log = () => {} }) {
  const dates = plan.dates;
  let ok = true;

  const overall = await client.getPortfolio(null);
  if (overall.outcome !== "ok") {
    return { ok: false, checks: [{ id: "availableDates", ok: false, error: `HTTP ${overall.httpStatus} ${overall.error}` }], ocr: ocrPresence(results, plan) };
  }
  const serverDates = Array.isArray(overall.portfolio.availableDates) ? overall.portfolio.availableDates : [];
  const available = new Set(serverDates);

  const dateChecks = [];
  for (const date of dates) {
    const expected = expectedPortfolioAsOf(db, date);
    const response = await client.getPortfolio(date);
    if (response.outcome !== "ok") {
      ok = false;
      dateChecks.push({ id: `asOf:${date}`, endpoint: `GET /api/portfolio?asOf=${date}`, ok: false, error: `HTTP ${response.httpStatus} ${response.error}` });
      continue;
    }
    const actual = response.portfolio;
    const diffs = [];
    for (const key of TOTAL_KEYS) {
      if (!closeEnough(expected.totals[key], actual?.totals?.[key])) diffs.push(`${key}: 預期 ${expected.totals[key]}，實際 ${actual?.totals?.[key]}`);
    }
    const expectedKeys = identityKeys(expected.importsUsed);
    const actualKeys = identityKeys(actual?.importsUsed ?? []);
    for (const key of expectedKeys) if (!actualKeys.has(key)) diffs.push(`importsUsed 缺少 ${key}`);
    for (const key of actualKeys) if (!expectedKeys.has(key)) diffs.push(`importsUsed 多出 ${key}（部署端有本機沒有的批次）`);
    const serverPositions = Array.isArray(actual?.positions) ? actual.positions.length : null;
    if (serverPositions !== null && serverPositions !== expected.totals.positionCount) diffs.push(`positions 陣列 ${serverPositions} 筆與 totals.positionCount ${expected.totals.positionCount} 不符`);
    ok &&= diffs.length === 0;
    if (diffs.length) log(`! 驗證不符 ${date}：${diffs.join("；")}`);
    dateChecks.push({
      id: `asOf:${date}`,
      endpoint: `GET /api/portfolio?asOf=${date}`,
      ok: diffs.length === 0,
      expectedTotals: expected.totals,
      actualTotals: actual?.totals ?? null,
      expectedImportsUsed: [...expectedKeys],
      actualImportsUsed: [...actualKeys],
      diffs,
    });
  }

  const missingDates = dates.filter((date) => !available.has(date));
  const oldestServerDate = serverDates.length ? serverDates.reduce((oldest, date) => (date < oldest ? date : oldest), serverDates[0]) : null;
  const asOfPassed = new Map(dateChecks.map((check) => [check.id, check.ok]));
  // Only a full window proves the list was truncated; below the cap every applied date is listed, so
  // absence there is a real gap. Beyond it, absence is explained only by the date's own asOf read.
  const windowTruncated = serverDates.length >= AVAILABLE_DATES_WINDOW;
  const cappedOutDates = windowTruncated ? missingDates.filter((date) => date < oldestServerDate && asOfPassed.get(`asOf:${date}`) === true) : [];
  const blockingDates = missingDates.filter((date) => !cappedOutDates.includes(date));
  ok &&= blockingDates.length === 0;
  const availableDatesCheck = {
    id: "availableDates",
    endpoint: "GET /api/portfolio",
    ok: blockingDates.length === 0,
    expectedDates: dates,
    serverDates: [...available],
    windowCap: AVAILABLE_DATES_WINDOW,
    oldestServerDate,
    missingDates,
    blockingDates,
    cappedOutDates,
  };

  return { ok, checks: [availableDatesCheck, ...dateChecks], ocr: ocrPresence(results, plan) };
}

function ocrPresence(results, plan) {
  const uploaded = results.ocr.filter((item) => item.outcome === "uploaded" || item.outcome === "already_uploaded_from_journal");
  return {
    // The route exposes at most the 20 newest OCR rows and no image hash, so absence proves nothing.
    exactVerification: "unsupported",
    reason: "GET /api/portfolio 只列出最近 20 筆 ocr_documents 的 id/filename/docType/confidence/reviewStatus，不含 object_key 與圖片雜湊",
    uploaded: uploaded.length,
    skipped: plan.ocrDocuments.filter((item) => item.status === "skipped").length,
    pendingWithoutJournal: results.ocr.filter((item) => item.code === "OCR_STATE_JOURNAL_REQUIRED").length,
  };
}

function countPlanned(items) {
  return items.filter((item) => item.status === "planned").length;
}

function identityKeys(importsUsed) {
  return new Set(importsUsed.map((item) => `${item.filename}|${item.sourceKind}|${item.asOfDate}|${item.rowCount}`));
}

function identityOf(item) {
  return { localImportId: item.localImportId, filename: item.filename, sourceKind: item.sourceKind, asOfDate: item.asOfDate, fileHash: item.fileHash };
}
