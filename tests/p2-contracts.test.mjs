import assert from "node:assert/strict";
import test, { after } from "node:test";
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

const {
  ASSET_IDENTITY_VERSION,
  LOGICAL_IMPORT_KEY_VERSION,
  buildCanonicalContentHash,
  buildLogicalImportKey,
  normalizeAssetCode,
  normalizeAssetName,
  resolveAssetIdentity,
  resolveSupersedesWinner,
} = await vite.ssrLoadModule("/lib/p2-contracts.ts");

test("logical import key identifies the logical slot, not its content revision", async () => {
  const input = {
    accountKey: "acct-a",
    scopeKey: "securities",
    sourceKind: "stock_csv",
    logicalPeriodKey: "2026-10-07",
  };
  const first = await buildLogicalImportKey(input);
  const second = await buildLogicalImportKey({ ...input });
  assert.equal(first, second);
  assert.ok(first.startsWith(LOGICAL_IMPORT_KEY_VERSION + ":"));
  assert.notEqual(first, await buildLogicalImportKey({ ...input, accountKey: "acct-b" }));
  assert.notEqual(first, await buildLogicalImportKey({ ...input, logicalPeriodKey: "2026-10-08" }));
  assert.notEqual(first, await buildLogicalImportKey({ ...input, sourceNativeImportId: "statement-2" }));
});

test("canonical content hash is order-insensitive and ignores raw formatting metadata", async () => {
  const rowsA = [
    { assetName: "Ａ基金", units: 1, currency: "USD", raw: { sourceFile: "a.csv", note: "x" } },
    { assetName: "B Fund", units: 2, currency: "USD", raw: { sourceFile: "a.csv" } },
  ];
  const rowsB = [
    { currency: "USD", units: 2, assetName: "B Fund", raw: { sourceFile: "renamed.csv" } },
    { currency: "USD", units: 1, assetName: "A基金", raw: { sourceFile: "renamed.csv", note: "different" } },
  ];
  assert.equal(await buildCanonicalContentHash(rowsA), await buildCanonicalContentHash(rowsB));
  assert.notEqual(
    await buildCanonicalContentHash(rowsA),
    await buildCanonicalContentHash([{ ...rowsA[0], units: 3 }, rowsA[1]]),
  );
});

test("supersedes winner follows new-to-old pointer only", () => {
  const base = { accountKey: "acct-a", scopeKey: "funds", asOfDate: "2026-10-07", sourceRole: "authoritative" };
  const result = resolveSupersedesWinner([
    { id: 10, ...base, supersedesImportId: null },
    { id: 11, ...base, supersedesImportId: 10 },
    { id: 12, ...base, supersedesImportId: 11 },
  ]);
  assert.equal(result.status, "UNIQUE");
  assert.equal(result.winner.id, 12);
});

test("same-day imports without a unique supersedes chain fail closed", () => {
  const base = { accountKey: "acct-a", scopeKey: "funds", asOfDate: "2026-10-07", sourceRole: "authoritative" };
  assert.deepEqual(resolveSupersedesWinner([
    { id: 1, ...base, supersedesImportId: null },
    { id: 2, ...base, supersedesImportId: null },
  ]), { status: "AMBIGUOUS", reason: "terminal_count_not_one" });
  assert.equal(resolveSupersedesWinner([
    { id: 1, ...base, supersedesImportId: 2 },
    { id: 2, ...base, supersedesImportId: 1 },
  ]).status, "AMBIGUOUS");
});

test("asset normalization is exact, not fuzzy", () => {
  assert.equal(normalizeAssetCode(" 00-50 "), "0050");
  assert.equal(normalizeAssetName("  Ａ基金   USD "), "a基金 usd");
});

const registry = {
  assets: [
    { assetId: 1, assetClass: "FUND", canonicalName: "Alpha Growth Fund", currency: "USD", shareClass: "A", distributionMode: "ACCUMULATING" },
    { assetId: 2, assetClass: "FUND", canonicalName: "Alpha Growth Fund", currency: "USD", shareClass: "A", distributionMode: "DISTRIBUTING" },
    { assetId: 3, assetClass: "EQUITY", canonicalName: "台灣積體電路製造" },
    { assetId: 4, assetClass: "EQUITY", canonicalName: "同名公司" },
    { assetId: 5, assetClass: "EQUITY", canonicalName: "同名公司" },
  ],
  codes: [
    { assetId: 1, codeType: "FUND_CODE", normalizedCode: "F001" },
    { assetId: 3, codeType: "TWSE", normalizedCode: "2330" },
  ],
  mappings: [
    { assetId: 3, assetClass: "EQUITY", normalizedAlias: "台積電" },
  ],
};

test("asset identity uses reliable code first and enforces fund hard keys", () => {
  const ok = resolveAssetIdentity({
    assetClass: "FUND",
    rawCode: "F001",
    codeType: "FUND_CODE",
    rawName: "Alpha Growth Fund",
    currency: "USD",
    shareClass: "A",
    distributionMode: "ACCUMULATING",
  }, registry);
  assert.equal(ok.status, "UNIQUE");
  assert.equal(ok.assetId, 1);
  assert.equal(ok.tier, 1);
  assert.equal(ok.contractVersion, ASSET_IDENTITY_VERSION);

  const differentMode = resolveAssetIdentity({
    assetClass: "FUND",
    rawCode: "F001",
    codeType: "FUND_CODE",
    rawName: "Alpha Growth Fund",
    currency: "USD",
    shareClass: "A",
    distributionMode: "DISTRIBUTING",
  }, registry);
  assert.equal(differentMode.status, "UNRESOLVED");
  assert.equal(differentMode.reason, "code_hard_key_mismatch");

  const missing = resolveAssetIdentity({
    assetClass: "FUND",
    rawName: "Alpha Growth Fund",
    currency: "USD",
    shareClass: "A",
  }, registry);
  assert.equal(missing.status, "UNRESOLVED");
  assert.equal(missing.reason, "missing_fund_attrs");
});

test("approved mapping beats name fallback and ambiguous names fail closed", () => {
  const mapped = resolveAssetIdentity({ assetClass: "EQUITY", rawName: "台積電" }, registry);
  assert.equal(mapped.status, "UNIQUE");
  assert.equal(mapped.assetId, 3);
  assert.equal(mapped.tier, 2);

  const ambiguous = resolveAssetIdentity({ assetClass: "EQUITY", rawName: "同名公司" }, registry);
  assert.equal(ambiguous.status, "AMBIGUOUS");
  assert.deepEqual(ambiguous.candidates, [4, 5]);

  const fuzzy = resolveAssetIdentity({ assetClass: "EQUITY", rawName: "同名公" }, registry);
  assert.equal(fuzzy.status, "UNRESOLVED");
  assert.equal(fuzzy.reason, "no_candidate");
});
