import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrations = [
  "0000_sudden_punisher.sql",
  "0001_living_miss_america.sql",
  "0002_as_of_import_status.sql",
  "0003_glorious_puppet_master.sql",
  "0004_fund_risk_reward.sql",
  "0005_p2_import_identity.sql",
];

function openDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of migrations) {
    const sql = readFileSync(`${root}drizzle/${file}`, "utf8");
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const statement = chunk.trim();
      if (statement) sqlite.exec(statement);
    }
  }
  return sqlite;
}

function asD1(sqlite) {
  return {
    prepare(sql) {
      let values = [];
      const statement = sqlite.prepare(sql);
      const wrapper = {
        bind(...next) {
          values = next;
          return wrapper;
        },
        async all() {
          return { results: statement.all(...values) };
        },
        async first() {
          return statement.get(...values) ?? null;
        },
        async run() {
          return statement.run(...values);
        },
      };
      return wrapper;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

const virtualCloudflare = "\0p2-currency-cloudflare-workers";
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  logLevel: "error",
  resolve: { alias: { "@": root } },
  plugins: [{
    name: "p2-currency-cloudflare-workers",
    enforce: "pre",
    resolveId(id) {
      if (id === "cloudflare:workers") return virtualCloudflare;
    },
    load(id) {
      if (id === virtualCloudflare) {
        return "export const env = { get DB() { return globalThis.__P2CurrencyD1; } };";
      }
    },
  }],
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

after(async () => {
  delete globalThis.__P2CurrencyD1;
  await vite.close();
});

const { POST } = await vite.ssrLoadModule("/app/api/import/route.ts");

function p2Payload({ fileHash, currency, assetName = "Probe Fund" }) {
  const row = {
    assetName,
    assetType: "基金",
    units: 1,
    marketValueTwd: 100,
  };
  if (currency !== undefined) row.currency = currency;
  return {
    filename: `p2-${fileHash[0]}.csv`,
    fileHash,
    sourceKind: "stock_csv",
    asOfDate: "2026-10-07",
    accountKey: "acct-probe",
    accountKeyBasis: "explicit",
    scopeKey: "securities",
    coverageType: "full",
    rows: [row],
  };
}

async function postWithFreshDb(t, payload) {
  const sqlite = openDatabase();
  t.after(() => sqlite.close());
  globalThis.__P2CurrencyD1 = asD1(sqlite);
  const response = await POST(new Request("http://localhost/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));
  return { sqlite, response, body: await response.json() };
}

test("P2 import missing currency returns HTTP 400", async (t) => {
  const { response, body, sqlite } = await postWithFreshDb(t, p2Payload({ fileHash: "a".repeat(64) }));
  assert.equal(response.status, 400);
  assert.match(body.error, /currency/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imports").get().n, 0);
});

test("P2 import does not infer currency from a USD-looking fund name", async (t) => {
  const { response, sqlite } = await postWithFreshDb(t, p2Payload({
    fileHash: "b".repeat(64),
    assetName: "Alpha USD 美元基金",
    currency: "   ",
  }));
  assert.equal(response.status, 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM positions").get().n, 0);
});

test("P2 import accepts explicit TWD", async (t) => {
  const { response, sqlite } = await postWithFreshDb(t, p2Payload({
    fileHash: "c".repeat(64),
    currency: "TWD",
  }));
  assert.equal(response.status, 201);
  assert.equal(sqlite.prepare("SELECT currency FROM positions").get().currency, "TWD");
});

test("P2 import accepts explicit USD", async (t) => {
  const { response, sqlite } = await postWithFreshDb(t, p2Payload({
    fileHash: "d".repeat(64),
    currency: "USD",
  }));
  assert.equal(response.status, 201);
  assert.equal(sqlite.prepare("SELECT currency FROM positions").get().currency, "USD");
});

test("legacy import missing currency keeps the pre-existing TWD default", async (t) => {
  const { response, sqlite } = await postWithFreshDb(t, {
    filename: "legacy.csv",
    fileHash: "e".repeat(64),
    sourceKind: "stock_csv",
    asOfDate: "2026-10-07",
    rows: [{ assetName: "Legacy Fund", assetType: "基金", units: 1, marketValueTwd: 100 }],
  });
  assert.equal(response.status, 201);
  assert.equal(sqlite.prepare("SELECT currency FROM positions").get().currency, "TWD");
});
