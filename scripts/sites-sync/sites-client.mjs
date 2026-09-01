/**
 * HTTP client for the deployed ChatGPT Site.
 *
 * Only the four endpoints that already exist are used (app/api/import, ocr, snapshots, portfolio);
 * nothing here can write to the database behind the app's back.
 */
import { SyncError } from "./sqlite-source.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const RETRIABLE_STATUS = new Set([502, 503, 504, 522, 524, 525]);

export function classifyTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SyncError("TARGET_INVALID", `--site 不是合法的 URL：${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SyncError("TARGET_INVALID", `--site 只支援 http(s)，目前是 ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = url.protocol === "http:" || LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || isPrivateAddress(hostname);
  return {
    origin: url.origin,
    pathname: url.pathname.replace(/\/+$/, ""),
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    hostname,
    environment: local ? "local" : "production",
    scheme: url.protocol.replace(/:$/, ""),
  };
}

function isPrivateAddress(hostname) {
  // An unqualified name (no dot) cannot be a public Sites origin: it resolves via search domains or mDNS.
  if (!hostname.includes(".")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4) {
    const [, a, b] = v4.map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/i.test(hostname) || hostname === "::1" || hostname.startsWith("fe80:") || hostname.endsWith(".internal");
}

export function buildAuthHeaders({ headers = [], env = process.env } = {}) {
  const result = {};
  for (const entry of parseHeaderPairs(env.SITES_SYNC_HEADERS)) setHeader(result, entry);
  for (const entry of headers) setHeader(result, entry);
  return result;
}

function setHeader(target, entry) {
  const index = entry.indexOf(":");
  // The entry itself is the secret, so the message never quotes it back.
  if (index <= 0) throw new SyncError("HEADER_INVALID", "自訂標頭必須是「名稱:值」格式（名稱不可為空）");
  const name = entry.slice(0, index).trim();
  if (!/^[-!#$%&'*+.^_`|~0-9a-z]+$/i.test(name)) throw new SyncError("HEADER_INVALID", `標頭名稱「${name}」不合法`);
  target[name] = entry.slice(index + 1).trim();
}

/** `SITES_SYNC_HEADERS` carries real credentials, so it is parsed as JSON and never echoed. */
function parseHeaderPairs(value) {
  if (!value || !value.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SyncError("HEADER_INVALID", "SITES_SYNC_HEADERS 必須是 JSON 物件，例如 {\"authorization\":\"Bearer …\"}");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyncError("HEADER_INVALID", "SITES_SYNC_HEADERS 必須是 JSON 物件");
  }
  return Object.entries(parsed).map(([name, value]) => `${name}:${value}`);
}

export class SitesClient {
  constructor({ target, headers = {}, timeoutMs = 60_000, fetchImpl = globalThis.fetch, retries = 2, log = () => {} }) {
    if (typeof fetchImpl !== "function") throw new SyncError("TARGET_INVALID", "這個 Node 環境沒有 fetch，請改用 Node 18+ 執行個體");
    this.target = target;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.retries = retries;
    this.log = log;
    this.requests = [];
  }

  url(path) {
    return `${this.target.baseUrl}${path}`;
  }

  async send(path, { method, body, headers, retrySafe }) {
    const url = this.url(path);
    const attemptLimit = retrySafe ? this.retries + 1 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
      try {
        const response = await this.fetch(url, {
          method,
          body,
          headers: { ...this.headers, ...headers },
          signal: controller.signal,
        });
        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = { nonJson: text.slice(0, 500) };
        }
        this.requests.push({ method, path, status: response.status, attempt });
        if (RETRIABLE_STATUS.has(response.status) && attempt < attemptLimit) {
          this.log(`retry ${path} after HTTP ${response.status}`);
          await sleep(attempt * 500);
          continue;
        }
        return { status: response.status, payload };
      } catch (error) {
        lastError = error;
        this.requests.push({ method, path, status: null, attempt, error: error instanceof Error ? error.name : "Error" });
        if (attempt < attemptLimit) {
          this.log(`retry ${path} after ${error instanceof Error ? error.message : error}`);
          await sleep(attempt * 500);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SyncError("TRANSPORT_FAILED", `請求 ${method} ${path} 失敗：${lastError instanceof Error ? lastError.message : String(lastError)}`, { path });
  }

  /**
   * POST /api/import. 409 means the (fileHash, sourceKind, asOfDate) triple is already `applied`,
   * which is exactly what a rerun wants, so it counts as success without touching the numbers.
   */
  async postImport(payload) {
    const { status, payload: json } = await this.send("/api/import", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      // A committed D1 batch either landed or did not, and the triple dedupes a blind resend.
      retrySafe: true,
    });
    if (status === 201) return { outcome: "applied", serverImportId: json?.importId ?? null, response: json };
    if (status === 409) return { outcome: "already_applied", serverImportId: json?.importId ?? null, response: json };
    return { outcome: "failed", httpStatus: status, error: serverError(json), response: json };
  }

  async postSnapshot(snapshotDate) {
    const { status, payload: json } = await this.send("/api/snapshots", {
      method: "POST",
      body: JSON.stringify({ snapshotDate }),
      headers: { "content-type": "application/json" },
      retrySafe: true,
    });
    if (status === 201) return { outcome: "created", snapshot: json, response: json };
    if (status === 409) return { outcome: "already_exists", response: json };
    return { outcome: "failed", httpStatus: status, error: serverError(json), response: json };
  }

  /**
   * POST /api/ocr. app/api/ocr/route.ts has no idempotency key and invents its own object key, so a
   * resend after an ambiguous failure would create a second document: never retried automatically.
   */
  async postOcr({ form }) {
    const { status, payload: json } = await this.send("/api/ocr", { method: "POST", body: form, retrySafe: false });
    if (status === 201) return { outcome: "uploaded", serverDocumentId: json?.id ?? null, response: json };
    return { outcome: "failed", httpStatus: status, error: serverError(json), response: json };
  }

  async getPortfolio(asOfDate) {
    const path = asOfDate ? `/api/portfolio?asOf=${encodeURIComponent(asOfDate)}` : "/api/portfolio";
    const { status, payload: json } = await this.send(path, { method: "GET", retrySafe: true });
    if (status !== 200) return { outcome: "failed", httpStatus: status, error: serverError(json), response: json };
    return { outcome: "ok", portfolio: json };
  }
}

function serverError(json) {
  if (!json) return "空回應";
  if (typeof json.error === "string") return json.error;
  if (typeof json.nonJson === "string") return json.nonJson;
  return JSON.stringify(json).slice(0, 300);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
