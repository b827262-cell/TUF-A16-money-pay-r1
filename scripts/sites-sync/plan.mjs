/**
 * Builds the migration plan. This module never touches the network and never writes: the CLI only
 * constructs an HTTP client once --apply has passed every gate, so a dry-run cannot leak a request.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  IMPORT_ROW_CAP,
  OCR_IMAGE_BYTE_CAP,
  SyncError,
  isIsoDate,
  mapPositionToCanonicalRow,
  ocrImageCandidates,
  readAppliedImports,
  readOcrDocuments,
  readPortfolioSnapshots,
  readUnsyncablePositionCounts,
  expectedPortfolioAsOf,
  summarizeRows,
} from "./sqlite-source.mjs";

/** GET /api/portfolio names at most this many applied dates, newest first (lib/portfolio.ts listAppliedDates). */
export const AVAILABLE_DATES_WINDOW = 365;

export const API_CONSTRAINTS = {
  import: {
    endpoint: "POST /api/import",
    maxRowsPerRequest: IMPORT_ROW_CAP,
    idempotencyKey: ["fileHash", "sourceKind", "asOfDate"],
    appliedBatchAnswer: "HTTP 409（already applied）",
    missingAsOfDateBehavior: "伺服器會改用 Taipei 當日日期，因此日期遺漏時必須擋下",
    chunkProtocol: "none",
  },
  ocr: {
    endpoint: "POST /api/ocr",
    requiresImageBytes: true,
    maxImageBytes: OCR_IMAGE_BYTE_CAP,
    idempotencyKey: [],
    objectKeySource: "伺服器自行產生 ocr/<timestamp>-<uuid>-<name>，無法保留本機 object_key",
    reviewStatus: "伺服器固定寫入 reviewed，無法保留其他複審狀態",
  },
  snapshots: {
    endpoint: "POST /api/snapshots",
    idempotencyKey: ["snapshotDate"],
    conflictAnswer: "HTTP 409（該日期已有快照）",
    totalsSource: "伺服器依當下的 imports/positions 重算，不接受客戶端金額",
  },
  portfolio: {
    endpoint: "GET /api/portfolio?asOf=YYYY-MM-DD",
    exposes: ["asOfDate", "dataAsOf", "totals", "positions", "importsUsed", "imports", "ocrDocuments", "availableDates"],
    cappedFields: { imports: 20, ocrDocuments: 20, availableDates: AVAILABLE_DATES_WINDOW },
    exposesSnapshots: false,
    exposesRawJson: false,
    exposesObjectKey: false,
  },
};

/**
 * Why >1000-row batches are refused instead of split:
 *
 * /api/import keys a batch on (fileHash, sourceKind, asOfDate) and caps a request at 1000 rows, and
 * app/api/import/route.ts marks the batch `applied` inside the same D1 batch that inserts its rows.
 * A second request with the same triple therefore answers 409, so chunk 2 can never land; a request
 * carrying only chunk 1 leaves a complete-looking `applied` batch holding part of the history. Every
 * way around that requires forging the triple, and lib/portfolio.ts ranks current imports
 * `PARTITION BY source_kind ORDER BY as_of_date DESC, id DESC`: a forged suffix on source_kind makes
 * the chunks shadow each other (last chunk wins, the rest vanish from every view), and a forged
 * as_of_date or hash invents a statistics date that the source file never claimed. Both corrupt the
 * money silently, so the only server-supported path is a real upload-session endpoint.
 */
export const ROW_CAP_CONFLICT = {
  code: "IMPORT_ROW_CAP_EXCEEDED",
  summary: `單一歷史批次超過 /api/import 的 ${IMPORT_ROW_CAP} 筆上限，且伺服器沒有任何受支援的分塊協定可以沿用同一個冪等鍵。`,
  unsafeAlternatives: [
    { attempt: "同冪等鍵分塊重送", effect: "只有第一塊會套用的 201；後續塊得到 409，匯入永久半成品" },
    { attempt: "假造新的 file_hash", effect: "把同一份檔案宣稱成不同位元組，之後無法再比對重複匯入" },
    { attempt: "假造 source_kind 後綴", effect: "lib/portfolio.ts 依 source_kind 取最新批次，分塊會互相遮蔽並漏掉持倉" },
    { attempt: "假造 as_of_date", effect: "建立來源檔案從未宣稱过的統計日期，快照與比較基準全部失真" },
  ],
  remediation: [
    "先在部署端實作受支援的分塊協定（例如 POST /api/import/session 保留同一 (fileHash, sourceKind, asOfDate)，最後一塊才 commit 為 applied），再重跑本工具。",
    "或把原始 CSV 依「同一統計日期」還原成單一檔案，由 app 介面重新匯入一次（介面上限同样是 1,000 筆）。",
    "若這批歷史已不需要：在部署端連同它的 positions 一併刪除該 imports 列，再重跑規劃。單把 status 改回 pending 不是做法——route 遇到同一冪等鍵的 pending 列會沿用同一 id 並再插入一次持倉，只會複製整批。",
  ],
};

const IMAGE_CONTENT_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif",
};

export function buildPlan({ db, databasePath, target, options = {} }) {
  const { ocrImageDir = null, withSnapshots = false, imageReader = readImage } = options;
  const imports = readAppliedImports(db);
  const importItems = imports.map((record) => planImport(record));
  const blockedItems = importItems.filter((item) => item.status === "blocked");
  const ocrItems = readOcrDocuments(db).map((document) => planOcr(document, { ocrImageDir, imageReader }));
  const snapshotItems = readPortfolioSnapshots(db).map((snapshot) => planSnapshot(db, snapshot, { withSnapshots, blockedItems }));

  const dates = [...new Set(importItems.filter((item) => item.status === "planned").map((item) => item.asOfDate))].sort();
  const plannedRows = importItems.filter((item) => item.status === "planned").reduce((sum, item) => sum + item.positionCount, 0);
  return {
    tool: "sync-sqlite-to-sites",
    planVersion: 1,
    mode: "dry-run",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: {
      database: databasePath,
      appliedImports: imports.length,
      positions: { planned: plannedRows, ...readUnsyncablePositionCounts(db) },
    },
    target: target ? describeTarget(target) : null,
    apiConstraints: API_CONSTRAINTS,
    rowCapConflict: {
      ...ROW_CAP_CONFLICT,
      detected: blockedItems.filter((item) => item.code === "IMPORT_ROW_CAP_EXCEEDED").map((item) => ({
        localImportId: item.localImportId,
        filename: item.filename,
        sourceKind: item.sourceKind,
        asOfDate: item.asOfDate,
        positionCount: item.positionCount,
      })),
    },
    totals: {
      imports: count(importItems, "planned"),
      importRequests: importItems.filter((item) => item.status === "planned").length,
      positions: plannedRows,
      ocrPlanned: count(ocrItems, "planned"),
      ocrSkipped: count(ocrItems, "skipped"),
      snapshotsPlanned: count(snapshotItems, "planned"),
      snapshotsSkipped: count(snapshotItems, "skipped"),
      blocked: blockedItems.length,
      verificationDates: dates.length,
    },
    amounts: amountsFor(importItems),
    dates,
    imports: importItems,
    ocrDocuments: ocrItems,
    snapshots: snapshotItems,
    verification: verificationPlan(dates),
  };
}

function verificationPlan(dates) {
  return {
    checks: [
      { id: "availableDates", endpoint: "GET /api/portfolio", expect: `每個計畫內的統計日期都要出現在 availableDates；該欄位最多只列最近 ${AVAILABLE_DATES_WINDOW} 個日期，視窗外更舊的日期改由它自己的 asOf 查詢核對` },
      ...dates.map((date) => ({ id: `asOf:${date}`, endpoint: `GET /api/portfolio?asOf=${date}`, expect: "totals 與 importsUsed 必須等於本機重算結果" })),
    ],
    notVerifiable: [
      { field: "ocr_documents", reason: "GET /api/portfolio 只回傳最近 20 筆 OCR 的 id/filename/docType/confidence/reviewStatus，且不回傳 object_key 或圖片雜湊" },
      { field: "positions.raw_json", reason: "持倉明細不回傳 raw_json，只能核對金額與筆數" },
      { field: "portfolio_snapshots", reason: "沒有任何 GET 會回傳快照列；快照只能以 POST 回應的 totals 間接核對" },
      { field: "imports.created_at", reason: "匯入時間戳由伺服器重算，無法沿用本機值" },
    ],
  };
}

function planImport(record) {
  const identity = { localImportId: record.id, filename: record.filename, sourceKind: record.sourceKind, asOfDate: record.asOfDate, fileHash: record.fileHash };
  const reasons = [];
  let code = null;
  const rows = [];
  const rowIssues = [];
  for (const position of record.positions) {
    const mapped = mapPositionToCanonicalRow(position);
    if (mapped.ok) rows.push(mapped.row);
    else rowIssues.push(...mapped.reasons);
  }
  if (record.positions.length > IMPORT_ROW_CAP) {
    code = "IMPORT_ROW_CAP_EXCEEDED";
    reasons.push(ROW_CAP_CONFLICT.summary);
  }
  if (rowIssues.length) { code ??= "IMPORT_ROW_INVALID"; reasons.push(...rowIssues.slice(0, 20)); if (rowIssues.length > 20) reasons.push(`（另有 ${rowIssues.length - 20} 筆同樣問題）`); }
  // The route trims these three and 400s without them, and they are the whole idempotency key.
  if (!notBlank(record.filename) || !notBlank(record.fileHash) || !notBlank(record.sourceKind)) {
    code ??= "IMPORT_IDENTITY_INCOMPLETE";
    reasons.push("filename / file_hash / source_kind 任一為空，/api/import 會直接 400");
  }
  if (record.asOfDate === null || record.asOfDate === undefined || record.asOfDate === "") {
    // Sending it without a date would let the route stamp today: history would be silently re-dated.
    code ??= "IMPORT_MISSING_AS_OF_DATE";
    reasons.push("as_of_date 為 NULL；/api/import 會改用台北當日日期，等於竄改歷史統計日");
  } else if (!isIsoDate(record.asOfDate)) {
    code ??= "IMPORT_INVALID_AS_OF_DATE";
    reasons.push(`as_of_date「${record.asOfDate}」不是有效 YYYY-MM-DD，parseAsOfDate 會 400`);
  }
  if (Number(record.rowCount) !== record.positions.length) {
    code ??= "IMPORT_ROW_COUNT_MISMATCH";
    reasons.push(`imports.row_count=${record.rowCount} 與實際持倉 ${record.positions.length} 筆不符，本機批次不可信任`);
  }
  if (Number(record.parserVersion) > 1) {
    // /api/import always stamps its own PARSER_VERSION, so a newer local parser would be downgraded.
    code ??= "IMPORT_PARSER_VERSION_UNSUPPORTED";
    reasons.push(`本機 parser_version=${record.parserVersion} 高於 /api/import 寫入的 1，同步會把它降版`);
  }

  const base = {
    ...identity,
    status: code ? "blocked" : "planned",
    code,
    parserVersion: record.parserVersion,
    createdAt: record.createdAt,
    positionCount: record.positions.length,
    amounts: summarizeRows(rows),
    reasons,
  };
  if (code) return base;
  const body = {
    filename: record.filename,
    fileHash: record.fileHash,
    sourceKind: record.sourceKind,
    asOfDate: record.asOfDate,
    rows,
  };
  return {
    ...base,
    idempotencyKey: importKey(body),
    request: { method: "POST", path: "/api/import", headers: { "content-type": "application/json" }, body },
  };
}

function planOcr(document, { ocrImageDir, imageReader }) {
  const item = {
    localOcrId: document.id,
    filename: document.filename,
    objectKey: document.objectKey,
    docType: document.docType,
    confidence: document.confidence,
    reviewStatus: document.reviewStatus,
    createdAt: document.createdAt,
    rawTextChars: typeof document.rawText === "string" ? document.rawText.length : 0,
    extractedJsonChars: typeof document.extractedJson === "string" ? document.extractedJson.length : 0,
  };
  const skip = (code, reason, extra) => ({ ...item, status: "skipped", code, reason, ...extra });

  if (!notBlank(document.rawText)) return skip("OCR_EMPTY_RAW_TEXT", "raw_text 為空，/api/ocr 會 400（不會送上沒有文字的文件）");
  try {
    JSON.parse(document.extractedJson || "{}");
  } catch {
    return skip("OCR_INVALID_EXTRACTED_JSON", "extracted_json 不是合法 JSON，/api/ocr 會在 JSON.parse 階段 500");
  }
  if (typeof document.confidence !== "number" || !Number.isFinite(document.confidence)) {
    return skip("OCR_INVALID_CONFIDENCE", "confidence 不是有限數值");
  }
  if (document.reviewStatus !== "reviewed") {
    return skip("OCR_REVIEW_STATUS_NOT_PRESERVABLE", `/api/ocr 固定寫入 review_status='reviewed'，本機為「${document.reviewStatus}」，同步會竄改複審狀態`);
  }
  if (!ocrImageDir) {
    return skip("OCR_IMAGE_BYTES_NOT_IN_SQLITE", "ocr_documents 只存 R2 的 object_key，圖片位元組不在 SQLite 內；如需搬移原圖，請把圖片放到本機目錄並用 --ocr-image-dir 指路（R2 沒有可寫入的 API 端點）");
  }
  const candidates = ocrImageCandidates(document, ocrImageDir);
  let found = null;
  for (const path of candidates) {
    const image = imageReader(path);
    if (image) {
      found = { path, ...image };
      break;
    }
  }
  if (!found) {
    return skip("OCR_LOCAL_IMAGE_NOT_FOUND", `在 --ocr-image-dir 內找不到原圖（試過 ${candidates.length} 個候選路徑）`, { imageCandidates: candidates });
  }
  if (found.bytes > OCR_IMAGE_BYTE_CAP) {
    return skip("OCR_IMAGE_TOO_LARGE", `原圖 ${found.bytes} bytes 超過 /api/ocr 的 ${OCR_IMAGE_BYTE_CAP} bytes 上限`);
  }
  const dot = found.path.lastIndexOf(".");
  const contentType = IMAGE_CONTENT_TYPES[dot >= 0 ? found.path.slice(dot).toLowerCase() : ""] ?? "application/octet-stream";
  return {
    ...item,
    status: "planned",
    code: null,
    reason: null,
    image: { path: found.path, bytes: found.bytes, sha256: found.sha256, contentType },
    idempotencyKey: ocrKey({ localOcrId: document.id, objectKey: document.objectKey }),
    request: {
      method: "POST",
      path: "/api/ocr",
      multipart: {
        // Field names are exactly what app/api/ocr/route.ts reads back out of request.formData().
        fields: { rawText: document.rawText, extractedJson: document.extractedJson || "{}", docType: document.docType, confidence: String(document.confidence) },
        file: { field: "file", filename: document.filename, path: found.path, bytes: found.bytes, sha256: found.sha256 },
      },
    },
  };
}

function planSnapshot(db, snapshot, { withSnapshots, blockedItems }) {
  const item = {
    localSnapshotId: snapshot.id,
    snapshotDate: snapshot.snapshotDate,
    localRow: {
      positionCount: snapshot.positionCount,
      costBasisTwd: snapshot.costBasisTwd,
      marketValueTwd: snapshot.marketValueTwd,
      pnlTwd: snapshot.pnlTwd,
      dividendTwd: snapshot.dividendTwd,
    },
    createdAt: snapshot.createdAt,
  };
  const skip = (code, reason, extra) => ({ ...item, status: "skipped", code, reason, request: null, expectedTotals: null, matchesLocal: null, ...extra });
  if (!isIsoDate(snapshot.snapshotDate)) return skip("SNAPSHOT_DATE_INVALID", "snapshot_date 不是有效 YYYY-MM-DD，/api/snapshots 會 400");
  if (!withSnapshots) return skip("SNAPSHOT_STAGE_DISABLED", "未指定 --with-snapshots；快照一律由伺服器的 imports 重算，不會複製本機金額");
  const blockers = blockedItems.filter((blocked) => typeof blocked.asOfDate === "string" && blocked.asOfDate <= snapshot.snapshotDate);
  if (blockers.length) {
    return skip(
      "SNAPSHOT_DEPENDS_ON_BLOCKED_IMPORT",
      `有 ${blockers.length} 個較早的匯入批次被擋下，重建出來的快照金額會不完整`,
      { blockedImports: blockers.map((blocked) => ({ localImportId: blocked.localImportId, filename: blocked.filename, sourceKind: blocked.sourceKind, asOfDate: blocked.asOfDate, code: blocked.code })) },
    );
  }
  // /api/snapshots recomputes from the server's own imports, so only the date travels over the wire.
  const expected = expectedPortfolioAsOf(db, snapshot.snapshotDate);
  const matchesLocal = sameTotals(expected.totals, item.localRow);
  return {
    ...item,
    status: expected.totals.positionCount ? "planned" : "skipped",
    code: expected.totals.positionCount ? null : "SNAPSHOT_NO_POSITIONS_AT_DATE",
    reason: expected.totals.positionCount ? null : "本機在該統計日期下沒有已套用的持倉，/api/snapshots 會 400",
    expectedTotals: expected.totals,
    expectedImportsUsed: expected.importsUsed.map((used) => ({ filename: used.filename, sourceKind: used.sourceKind, asOfDate: used.asOfDate, rowCount: used.rowCount })),
    matchesLocal,
    request: expected.totals.positionCount ? { method: "POST", path: "/api/snapshots", headers: { "content-type": "application/json" }, body: { snapshotDate: snapshot.snapshotDate } } : null,
    idempotencyKey: expected.totals.positionCount ? snapshotKey({ snapshotDate: snapshot.snapshotDate }) : null,
  };
}

function sameTotals(a, b) {
  return ["positionCount", "costBasisTwd", "marketValueTwd", "pnlTwd", "dividendTwd"].every((key) => closeEnough(a[key], b[key]));
}

export function closeEnough(left, right, tolerance = 1e-6) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

export function sameTotalsAcrossResponse(expected, actual) {
  if (!actual) return false;
  return ["positionCount", "costBasisTwd", "marketValueTwd", "pnlTwd", "dividendTwd"].every((key) => closeEnough(expected[key], actual[key]));
}

function describeTarget(target) {
  return { baseUrl: target.baseUrl, hostname: target.hostname, environment: target.environment, scheme: target.scheme };
}

function amountsFor(items) {
  return items.filter((item) => item.status === "planned").reduce((sum, item) => ({
    positionCount: sum.positionCount + item.amounts.positionCount,
    costBasisTwd: roundAmount(sum.costBasisTwd + item.amounts.costBasisTwd),
    marketValueTwd: roundAmount(sum.marketValueTwd + item.amounts.marketValueTwd),
    pnlTwd: roundAmount(sum.pnlTwd + item.amounts.pnlTwd),
    dividendTwd: roundAmount(sum.dividendTwd + item.amounts.dividendTwd),
  }), { positionCount: 0, costBasisTwd: 0, marketValueTwd: 0, pnlTwd: 0, dividendTwd: 0 });
}

function roundAmount(value) {
  return Math.round(value * 1e6) / 1e6;
}

function count(items, status) {
  return items.filter((item) => item.status === status).length;
}

function notBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function importKey({ fileHash, sourceKind, asOfDate }) {
  return `import:${fileHash}|${sourceKind}|${asOfDate}`;
}

export function ocrKey({ localOcrId, objectKey }) {
  return `ocr:${localOcrId}|${objectKey}`;
}

export function snapshotKey({ snapshotDate }) {
  return `snapshot:${snapshotDate}`;
}

function readImage(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  const buffer = readFileSync(path);
  return { bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

export function assertPlanAppliable(plan) {
  const blocked = plan.imports.filter((item) => item.status === "blocked");
  if (!blocked.length) return;
  const detail = blocked.map((item) => `  - [${item.code}] ${item.filename}（${item.sourceKind} · ${item.asOfDate ?? "無日期"} · id=${item.localImportId}）：${item.reasons.join("；")}`);
  const remediation = blocked.some((item) => item.code === "IMPORT_ROW_CAP_EXCEEDED") ? `\n\n${ROW_CAP_CONFLICT.remediation.join("\n")}` : "";
  throw new SyncError(
    "PLAN_BLOCKED",
    `有 ${blocked.length} 個匯入批次無法安全同步，已拒絕寫入：\n${detail.join("\n")}${remediation}`,
    { blocked: blocked.map((item) => ({ localImportId: item.localImportId, filename: item.filename, sourceKind: item.sourceKind, asOfDate: item.asOfDate, code: item.code, reasons: item.reasons })) },
  );
}
