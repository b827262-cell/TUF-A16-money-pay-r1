#!/usr/bin/env node
/**
 * Local SQLite (dev D1 / wrangler state) -> deployed ChatGPT Site data sync.
 *
 * Dry-run by default: no HTTP client is even constructed unless --apply is present. All movement
 * goes through the app's own endpoints, so the deployed database keeps its invariants.
 */
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyPlan, assertJournalWritable, preflightTarget, journalScope, readJournal, verifyPlan, writeJournal } from "./sites-sync/apply.mjs";
import { SitesClient, buildAuthHeaders, classifyTarget } from "./sites-sync/sites-client.mjs";
import { SyncError, openSourceDatabase } from "./sites-sync/sqlite-source.mjs";
import { assertPlanAppliable, buildPlan } from "./sites-sync/plan.mjs";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_APPLY_FAILED = 3;
export const EXIT_VERIFICATION_FAILED = 4;

/** --plan-json／--summary-json 含有真實投資金額與持股名稱，因此和 OCR 狀態檔一樣只讓擁有者可讀寫。 */
const OUTPUT_FILE_MODE = 0o600;

/** Every code here refuses while the run has sent zero write requests, so the operator fixes it locally. */
const REFUSAL_CODES = new Set(["PLAN_BLOCKED", "TARGET_VERSION_UNSUPPORTED", "JOURNAL_UNREADABLE", "JOURNAL_VERSION_UNSUPPORTED", "JOURNAL_SCOPE_MISMATCH", "JOURNAL_STATE_UNWRITABLE"]);

const FLAGS = {
  "--db": "db",
  "--site": "site",
  "--plan-json": "planJson",
  "--summary-json": "summaryJson",
  "--state": "state",
  "--ocr-image-dir": "ocrImageDir",
  "--timeout-ms": "timeoutMs",
  "--header": "headers",
};
const BOOLEANS = new Set(["--apply", "--allow-local-target", "--with-snapshots", "--help"]);

const USAGE = `用法：node scripts/sync-sqlite-to-sites.mjs --db <sqlite 路徑> --site <sites URL> [選項]

預設是 dry-run：不會建立 HTTP client，也不會送出任何請求。

  --db <path>             來源 SQLite（dev D1／wrangler state）檔案路徑，唯讀開啟
  --site <url>            部署站点的 URL，例如 https://site.example.com
  --apply                 真的送出請求（沒有這個參數就一定不寫）
  --allow-local-target    允許把 --apply 寫到 localhost／内網／http 目標（預設拒絕）
  --with-snapshots        匯入完成後依 snapshot_date 重建統計快照（POST /api/snapshots）
  --ocr-image-dir <dir>   OCR 原圖所在的本機目錄；沒有這個選項時 OCR 一律回報為無法同步
  --state <path>          OCR 狀態檔（/api/ocr 沒有冪等鍵，需要它才不會重複上傳）。狀態檔會綁定這輪
                          的 --site 目標與 --db 來源資料庫：換了任何一個都拒絕沿用舊記錄跳過上傳。
                          有 OCR 待上傳時，會先確認這個路徑寫得下去，才送出任何請求
  --plan-json <path>      把遷移計畫寫成 JSON（含完整預送請求）；用 - 輸出到 stdout，
                          此時文字報告改走 stderr，讓管線只接到 JSON
  --summary-json <path>   把機器可讀結果摘要寫成 JSON（同上，- 代表 stdout）
  --header <name:value>   額外請求標頭，可重複；值不會被寫進任何輸出
                          （也可以 SITES_SYNC_HEADERS='{"name":"value"}' 提供）
  --timeout-ms <n>        單一請求逾時毫秒（預設 60000）
  --help                  顯示這個說明

回復碼：0 成功 · 2 用法錯誤／計畫被擋下／目標被拒絕 · 3 套用失敗 · 4 驗證不符

前提與注意：
  · --apply 一定會先 GET /api/portfolio 預檢（需要 Version-3 的 totals／importsUsed／availableDates 形狀）；
    遇到 401／403 或舊版回應都會在任何寫入請求送出前停下（exit 2），本輪零個 POST。
  · 計畫與摘要 JSON 含有真實投資金額與持股名稱，請勿提交到這個公開儲存庫。
  · drizzle/0002 之前的舊批次，as_of_date 是以 date(created_at,'+8 hours') 回填的台北日曆日；
    工具分辨不出它與當初真實的統計日期，同步前請先自行核對這些日期。
  · 套用中途失敗就直接重跑：每批持倉與 applied 標記落在同一個 D1 batch 內，被打斷的 imports
    列必然是零持倉的 pending，route 會沿用同一冪等鍵補完，不會重複插入持倉。`;

export function parseArgs(argv) {
  const options = { headers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw usageError(`只認識 -- 開頭的參數，收到「${token}」`);
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    if (BOOLEANS.has(flag)) {
      if (inline !== undefined) throw usageError(`${flag} 是旗標，不接受值`);
      options[camelCase(flag.slice(2))] = true;
      continue;
    }
    const name = FLAGS[flag];
    if (!name) throw usageError(`未知參數：${flag}`);
    let value = inline;
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw usageError(`${flag} 需要一個值`);
      index += 1;
    }
    if (name === "headers") options.headers.push(value);
    else options[name] = value;
  }
  if (options.help) return { help: true, options };
  if (!options.db) throw usageError("需要 --db <路徑>");
  if (!options.site) throw usageError("需要 --site <URL>");
  if (options.timeoutMs !== undefined && !(Number(options.timeoutMs) > 0)) throw usageError("--timeout-ms 必須是正整數");
  return { options };
}

function camelCase(dashed) {
  return dashed.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function usageError(message) {
  return new SyncError("USAGE", message);
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const env = io.env ?? process.env;

  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      stdout(USAGE);
      return EXIT_OK;
    }
  } catch (error) {
    stderr(`${error.message}`);
    stderr("");
    stderr(USAGE);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  const writes = [];

  let target;
  let db;
  try {
    target = classifyTarget(options.site);
    if (options.apply && target.environment === "local" && !options.allowLocalTarget) {
      throw new SyncError("TARGET_LOCAL_REFUSED", `目標 ${target.baseUrl} 是 localhost／内網／http 位址。確定要寫入這種位址請再加上 --allow-local-target。`);
    }
    db = openSourceDatabase(options.db);
  } catch (error) {
    reportError(error, stderr);
    return EXIT_USAGE;
  }

  try {
    const headers = buildAuthHeaders({ headers: options.headers, env });
    const plan = buildPlan({
      db,
      databasePath: resolve(options.db),
      target,
      options: { ocrImageDir: options.ocrImageDir ?? null, withSnapshots: Boolean(options.withSnapshots) },
    });
    plan.mode = options.apply ? "apply" : "dry-run";
    plan.authHeaders = Object.keys(headers);

    // A "-" target promises stdout holds parseable JSON, so the human report steps out of its way.
    const say = options.planJson === "-" || options.summaryJson === "-" ? stderr : stdout;
    if (options.planJson) writes.push({ path: options.planJson, payload: plan, label: "遷移計畫" });
    say(renderPlanReport(plan, options));

    const blockedImports = plan.imports.filter((item) => item.status === "blocked");
    if (!options.apply) {
      const summary = buildSummary({ plan, mode: "dry-run", headers, results: null, verification: null, exitCode: blockedImports.length ? EXIT_USAGE : EXIT_OK });
      if (options.summaryJson) writes.push({ path: options.summaryJson, payload: summary, label: "結果摘要" });
      finishWrites(writes, stdout, stderr);
      if (blockedImports.length) stderr(`\n計畫含 ${blockedImports.length} 個無法安全同步的批次；--apply 會被拒絕（exit ${EXIT_USAGE}）。`);
      else stderr("\ndry-run 完成：未送出任何請求。要真的寫入請加 --apply。");
      return blockedImports.length ? EXIT_USAGE : EXIT_OK;
    }

    if (target.environment === "production") {
      stderr("");
      stderr(`!! 即將寫入【正式站】 ${target.baseUrl}`);
      stderr(`!! 資料會套用到 D1（imports/positions${options.withSnapshots ? "/portfolio_snapshots" : ""}）${plan.ocrDocuments.some((item) => item.status === "planned") ? " 與 R2（OCR 原圖）" : ""}。`);
      stderr(`!! 即將送出 ${plan.totals.importRequests} 個 /api/import 請求、${plan.totals.positions} 筆持倉。`);
      stderr("");
    }

    assertPlanAppliable(plan);
    const client = new SitesClient({ target, headers, timeoutMs: options.timeoutMs ? Number(options.timeoutMs) : undefined, fetchImpl: io.fetchImpl, log: stderr });
    await preflightTarget({ client, log: stderr });
    const journal = readJournal(options.state ?? null, journalScope({ target, databasePath: resolve(options.db) }));
    const ocrPlanned = plan.ocrDocuments.some((item) => item.status === "planned");
    if (ocrPlanned) {
      if (journal.path) {
        // An upload that cannot be journalled would be re-sent by the next run as a second document,
        // so the state file's parent and its writability are proven while this run has sent zero POSTs.
        assertJournalWritable(journal, { log: stderr });
      } else {
        stderr("提醒：有 OCR 原圖可上傳但沒有 --state 狀態檔；/api/ocr 沒有冪等鍵，這輪會跳過上傳而不重複送出。");
      }
    }

    const { results, failures } = await applyPlan({ plan, client, journal, log: stderr });
    const verification = await verifyPlan({ db, plan, client, results, log: stderr });
    writeJournal(journal);

    let exitCode = EXIT_OK;
    if (failures.length) exitCode = EXIT_APPLY_FAILED;
    else if (!verification.ok) exitCode = EXIT_VERIFICATION_FAILED;
    const summary = buildSummary({ plan, mode: "apply", headers, results, failures, verification, exitCode });
    if (options.summaryJson) writes.push({ path: options.summaryJson, payload: summary, label: "結果摘要" });
    say(renderApplyReport(plan, results, failures, verification));
    finishWrites(writes, stdout, stderr);
    if (exitCode === EXIT_OK) say("同步完成，且部署站回讀的數字與本機一致。");
    return exitCode;
  } catch (error) {
    reportError(error, stderr);
    const refused = error instanceof SyncError && REFUSAL_CODES.has(error.code);
    return refused ? EXIT_USAGE : EXIT_APPLY_FAILED;
  } finally {
    db.close();
  }
}

function buildSummary({ plan, mode, headers, results, failures, verification, exitCode }) {
  return {
    tool: "sync-sqlite-to-sites",
    summaryVersion: 1,
    mode,
    exitCode,
    generatedAt: plan.generatedAt,
    source: plan.source,
    target: plan.target,
    authHeaderNames: Object.keys(headers),
    totals: plan.totals,
    amounts: plan.amounts,
    dates: plan.dates,
    blocked: plan.imports.filter((item) => item.status === "blocked").map((item) => ({ localImportId: item.localImportId, filename: item.filename, sourceKind: item.sourceKind, asOfDate: item.asOfDate, code: item.code, reasons: item.reasons })),
    ocrUnsyncable: plan.ocrDocuments.filter((item) => item.status === "skipped").map((item) => ({ localOcrId: item.localOcrId, filename: item.filename, objectKey: item.objectKey, code: item.code, reason: item.reason })),
    requestsSent: results ? { imports: results.imports.length, snapshots: results.snapshots.length, ocr: results.ocr.length } : null,
    results: results ?? null,
    failures: failures ?? null,
    verification: verification ?? null,
    notVerifiable: plan.verification.notVerifiable,
  };
}

function renderPlanReport(plan, options) {
  const lines = [];
  lines.push("連薪總署 · SQLite → Sites 資料同步");
  lines.push(`模式：${plan.mode === "apply" ? "APPLY（會寫入）" : "DRY-RUN（不送任何請求）"}`);
  lines.push(`來源：${plan.source.database}`);
  lines.push(`目標：${plan.target.baseUrl}［${plan.target.environment === "production" ? "正式站" : "本機／内網"}］${plan.authHeaders.length ? ` · 自訂標頭 ${plan.authHeaders.join(", ")}` : ""}`);
  lines.push("");
  lines.push(`匯入 /api/import：計畫 ${plan.totals.imports} 批 · ${plan.totals.positions} 筆 · 統計日期 ${plan.dates.join("、") || "（無）"}`);
  lines.push(`  金額合計：成本 ${fmt(plan.amounts.costBasisTwd)} · 市值 ${fmt(plan.amounts.marketValueTwd)} · 損益 ${fmt(plan.amounts.pnlTwd)} · 配息 ${fmt(plan.amounts.dividendTwd)}`);
  for (const item of plan.imports.filter((entry) => entry.status === "planned")) {
    lines.push(`  ✓ id=${item.localImportId} ${item.filename}（${item.sourceKind} · ${item.asOfDate} · ${item.positionCount} 筆 · hash ${short(item.fileHash)}）`);
  }
  for (const item of plan.imports.filter((entry) => entry.status === "blocked")) {
    lines.push(`  ✗ 擋下 id=${item.localImportId} ${item.filename}（${item.sourceKind} · ${item.asOfDate ?? "無日期"} · ${item.positionCount} 筆）[${item.code}]`);
    for (const reason of item.reasons.slice(0, 3)) lines.push(`      ${reason}`);
  }
  const localSkipped = plan.source.positions.pendingBatch + plan.source.positions.noBatch;
  if (localSkipped) lines.push(`  · 本機另有 ${localSkipped} 筆持倉不屬於任何已套用批次，不會同步`);

  lines.push("");
  lines.push(`OCR /api/ocr：可上傳 ${plan.totals.ocrPlanned} 筆 · 無法同步 ${plan.totals.ocrSkipped} 筆`);
  for (const item of plan.ocrDocuments.filter((entry) => entry.status === "planned")) {
    lines.push(`  ✓ id=${item.localOcrId} ${item.filename}（${item.docType} · confidence ${item.confidence} · ${item.image.bytes} bytes ← ${item.image.path}）`);
  }
  for (const item of plan.ocrDocuments.filter((entry) => entry.status === "skipped")) {
    lines.push(`  ⚠ 跳過 id=${item.localOcrId} ${item.filename}（${item.docType} · ${item.rawTextChars} 字）[${item.code}]`);
    lines.push(`      ${item.reason}`);
  }

  lines.push("");
  lines.push(`快照 /api/snapshots：${options.withSnapshots ? "已啟用" : "未啟用（加 --with-snapshots 才會重建）"} · 計畫 ${plan.totals.snapshotsPlanned} 個 · 跳過 ${plan.totals.snapshotsSkipped} 個`);
  for (const item of plan.snapshots) {
    if (item.status === "planned") {
      lines.push(`  ✓ ${item.snapshotDate}：由伺服器依當時 imports 重算（本機記錄 ${item.localRow.positionCount} 筆 / ${fmt(item.localRow.marketValueTwd)}，${item.matchesLocal ? "與本機重算一致" : "與本機重算不符 → 以伺服器為準"}`);
    } else {
      lines.push(`  ⚠ 跳過 ${item.snapshotDate} [${item.code}] ${item.reason}`);
    }
  }

  lines.push("");
  lines.push(`驗證：套用後會比對 ${plan.verification.checks.length - 1} 個統計日期的 totals/importsUsed 與 availableDates`);
  for (const item of plan.verification.notVerifiable) lines.push(`  · 無法驗證 ${item.field}：${item.reason}`);
  if (plan.rowCapConflict.detected.length) {
    lines.push("");
    lines.push(`超過 1,000 筆的批次：${plan.rowCapConflict.detected.length} 個 —— ${plan.rowCapConflict.summary}`);
    for (const step of plan.rowCapConflict.remediation) lines.push(`  · ${step}`);
  }
  return lines.join("\n");
}

function renderApplyReport(plan, results, failures, verification) {
  const lines = ["", "套用結果"];
  for (const item of results.imports) lines.push(`  import id=${item.localImportId} ${item.sourceKind}/${item.asOfDate} → ${outcomeLabel(item.outcome)}${item.serverImportId ? `（server importId=${item.serverImportId}）` : ""}`);
  for (const item of results.snapshots) lines.push(`  snapshot ${item.snapshotDate} → ${outcomeLabel(item.outcome)}${item.serverTotals ? `（${item.serverTotals.positionCount} 筆 / ${fmt(item.serverTotals.marketValueTwd)}）` : ""}`);
  for (const item of results.ocr) lines.push(`  ocr id=${item.localOcrId} → ${outcomeLabel(item.outcome)}${item.serverDocumentId ? `（server id=${item.serverDocumentId}）` : ""}${item.code ? `（${item.code}）` : ""}`);
  for (const item of failures) {
    const who = item.stage === "import" ? `id=${item.localImportId} ${item.sourceKind}/${item.asOfDate}` : item.stage === "snapshot" ? item.snapshotDate : `id=${item.localOcrId}`;
    lines.push(`  ! ${item.stage} 失敗 ${who}${item.httpStatus ? ` HTTP ${item.httpStatus}` : ""}：${item.error ?? item.outcome ?? ""}`);
  }
  lines.push("");
  if (results.deferred) lines.push(`  已跳過：${results.deferred.snapshots} 個快照重建、${results.deferred.ocr} 筆 OCR 上傳（${results.deferred.reason}）`);
  lines.push(verification.ok ? "  驗證通過：部署站回讀的數字與本機重算一致。" : "  驗證不符：請檢查以下差異。");
  for (const check of verification.checks) {
    lines.push(`  ${check.ok ? "✓" : "✗"} ${check.id}`);
    for (const diff of check.diffs ?? []) lines.push(`      ${diff}`);
    if (check.blockingDates?.length) lines.push(`      availableDates 缺少：${check.blockingDates.join("、")}`);
    if (check.cappedOutDates?.length) lines.push(`      availableDates 僅列最近 ${check.windowCap} 個日期（最舊 ${check.oldestServerDate}），未含：${check.cappedOutDates.join("、")}——這些日期已各自以 asOf 回讀核對通過`);
    if (check.error) lines.push(`      ${check.error}`);
  }
  lines.push(`  OCR：${verification.ocr.uploaded} 筆已上傳、${verification.ocr.skipped} 筆無法同步（${verification.ocr.exactVerification}）`);
  return lines.join("\n");
}

function outcomeLabel(outcome) {
  return {
    applied: "已套用",
    already_applied: "早已套用（409，冪等成功）",
    created: "已建立",
    already_exists: "已存在（409，冪等成功）",
    uploaded: "已上傳",
    already_uploaded_from_journal: "狀態檔記錄過，跳過",
    skipped: "跳過",
    failed: "失敗",
  }[outcome] ?? outcome;
}

function finishWrites(writes, stdout, stderr) {
  for (const write of writes) {
    const text = `${JSON.stringify(write.payload, null, 2)}\n`;
    if (write.path === "-") {
      stdout(text);
      continue;
    }
    const path = resolve(write.path);
    if (!existsSync(dirname(path))) {
      stderr(`！${write.label}目錄不存在，未寫入 ${path}`);
      continue;
    }
    writeFileSync(path, text, { mode: OUTPUT_FILE_MODE });
    // writeFileSync only applies mode when it creates the file, so an existing report is re-pinned.
    chmodSync(path, OUTPUT_FILE_MODE);
    stderr(`${write.label}已寫入 ${path}（含真實投資金額，請勿提交）`);
  }
}

function reportError(error, stderr) {
  const code = error instanceof SyncError ? `[${error.code}] ` : "";
  stderr(`${code}${error instanceof Error ? error.message : String(error)}`);
  if (!(error instanceof SyncError)) stderr(error instanceof Error ? error.stack ?? "" : "");
}

function short(hash) {
  return typeof hash === "string" ? `${hash.slice(0, 8)}…` : String(hash);
}

function fmt(value) {
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 }).format(Number(value) ?? 0);
}

export function isDirectExecution(invocation = process.argv[1]) {
  return Boolean(invocation) && resolve(invocation) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  // fetch keeps its sockets warm; flush stdout, then stop instead of idling until they time out.
  process.stdout.write("", () => process.exit(code));
}
