export const LOGICAL_IMPORT_KEY_VERSION = "logical_import/v0.1";
export const ASSET_IDENTITY_VERSION = "asset_identity/v0.1.0";

export type SourceRole = "authoritative" | "supplemental" | "reconciliation";
export type CoverageType = "full" | "partial" | "legacy_unknown";
export type AccountKeyBasis = "explicit" | "registered_mapping" | "legacy_unknown";

export class P2ContractError extends Error {}

export const SOURCE_CONTRACTS: Record<string, { sourceRole: SourceRole; scopeKey: string | null; defaultCoverage: CoverageType }> = {
  stock_csv: { sourceRole: "authoritative", scopeKey: "securities", defaultCoverage: "legacy_unknown" },
  fund_csv: { sourceRole: "authoritative", scopeKey: "funds", defaultCoverage: "legacy_unknown" },
  ocr_reviewed: { sourceRole: "supplemental", scopeKey: null, defaultCoverage: "partial" },
  monthly_statement_video: { sourceRole: "supplemental", scopeKey: null, defaultCoverage: "partial" },
  fund_detail_ocr: { sourceRole: "supplemental", scopeKey: "funds", defaultCoverage: "partial" },
  portfolio_csv: { sourceRole: "reconciliation", scopeKey: "all_holdings", defaultCoverage: "partial" },
};

export function sourceContractFor(sourceKind: string) {
  return SOURCE_CONTRACTS[sourceKind] ?? { sourceRole: "supplemental" as const, scopeKey: null, defaultCoverage: "legacy_unknown" as const };
}

function requiredText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new P2ContractError(`${field} is required`);
  return text;
}

function optionalText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function bytesToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type LogicalImportKeyInput = {
  algorithmVersion?: string;
  accountKey: string;
  scopeKey: string;
  sourceKind: string;
  logicalPeriodKey: string;
  sourceNativeImportId?: string | null;
};

export async function buildLogicalImportKey(input: LogicalImportKeyInput): Promise<string> {
  const algorithmVersion = requiredText(input.algorithmVersion ?? LOGICAL_IMPORT_KEY_VERSION, "algorithmVersion");
  const accountKey = requiredText(input.accountKey, "accountKey");
  const scopeKey = requiredText(input.scopeKey, "scopeKey");
  const sourceKind = requiredText(input.sourceKind, "sourceKind");
  const logicalPeriodKey = requiredText(input.logicalPeriodKey, "logicalPeriodKey");
  const sourceNativeImportId = optionalText(input.sourceNativeImportId);
  const canonical = JSON.stringify([
    algorithmVersion,
    accountKey,
    scopeKey,
    sourceKind,
    logicalPeriodKey,
    sourceNativeImportId ? `native:${sourceNativeImportId}` : "native:none",
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `${algorithmVersion}:${bytesToHex(digest)}`;
}


function normalizeCanonicalScalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return String(value).normalize("NFKC").trim();
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "raw")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableObject(item)]),
    );
  }
  return normalizeCanonicalScalar(value);
}

export async function buildCanonicalContentHash(rows: Array<object>): Promise<string> {
  if (!Array.isArray(rows) || rows.length === 0) throw new P2ContractError("rows are required");
  const canonicalRows = rows
    .map((row) => JSON.stringify(stableObject(row)))
    .sort();
  const canonical = JSON.stringify(canonicalRows);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToHex(digest);
}

export type SupersedesNode = {
  id: number;
  accountKey: string | null;
  scopeKey: string | null;
  asOfDate: string | null;
  sourceRole: string;
  supersedesImportId: number | null;
};

export type SupersedesResolution =
  | { status: "UNIQUE"; winner: SupersedesNode }
  | { status: "AMBIGUOUS"; reason: string };

export function resolveSupersedesWinner(candidates: SupersedesNode[]): SupersedesResolution {
  if (candidates.length === 0) return { status: "AMBIGUOUS", reason: "no_candidates" };
  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only.accountKey || !only.scopeKey || !only.asOfDate) return { status: "AMBIGUOUS", reason: "missing_grain" };
    return { status: "UNIQUE", winner: only };
  }

  const first = candidates[0];
  if (!first.accountKey || !first.scopeKey || !first.asOfDate) return { status: "AMBIGUOUS", reason: "missing_grain" };
  for (const item of candidates) {
    if (!item.accountKey || !item.scopeKey || !item.asOfDate) return { status: "AMBIGUOUS", reason: "missing_grain" };
    if (
      item.accountKey !== first.accountKey
      || item.scopeKey !== first.scopeKey
      || item.asOfDate !== first.asOfDate
      || item.sourceRole !== first.sourceRole
    ) {
      return { status: "AMBIGUOUS", reason: "cross_grain_supersedes" };
    }
    if (item.supersedesImportId === item.id) return { status: "AMBIGUOUS", reason: "self_cycle" };
  }

  const byId = new Map(candidates.map((item) => [item.id, item]));
  const referenced = new Set<number>();
  for (const item of candidates) {
    if (item.supersedesImportId !== null) {
      if (!byId.has(item.supersedesImportId)) return { status: "AMBIGUOUS", reason: "pointer_outside_same_day_grain" };
      referenced.add(item.supersedesImportId);
    }
  }
  const terminals = candidates.filter((item) => !referenced.has(item.id));
  if (terminals.length !== 1) return { status: "AMBIGUOUS", reason: "terminal_count_not_one" };

  const visited = new Set<number>();
  let cursor: SupersedesNode | undefined = terminals[0];
  while (cursor) {
    if (visited.has(cursor.id)) return { status: "AMBIGUOUS", reason: "cycle" };
    visited.add(cursor.id);
    cursor = cursor.supersedesImportId === null ? undefined : byId.get(cursor.supersedesImportId);
  }
  if (visited.size !== candidates.length) return { status: "AMBIGUOUS", reason: "disconnected_chain" };
  return { status: "UNIQUE", winner: terminals[0] };
}

export type AssetObservation = {
  assetClass: string;
  rawCode?: string | null;
  codeType?: string | null;
  rawName?: string | null;
  currency?: string | null;
  shareClass?: string | null;
  distributionMode?: string | null;
};

export type AssetRegistryRecord = {
  assetId: number;
  assetClass: string;
  canonicalName: string;
  currency?: string | null;
  shareClass?: string | null;
  distributionMode?: string | null;
};

export type AssetCodeRecord = {
  assetId: number;
  codeType: string;
  normalizedCode: string;
};

export type AssetAliasRecord = {
  assetId: number;
  assetClass: string;
  normalizedAlias: string;
};

export type AssetIdentityResolution =
  | { status: "UNIQUE"; assetId: number; tier: 1 | 2 | 3; contractVersion: string; evidence: string }
  | { status: "AMBIGUOUS"; candidates: number[]; contractVersion: string; reason: string }
  | { status: "UNRESOLVED"; contractVersion: string; reason: string };

export function normalizeAssetCode(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toUpperCase().replace(/[\s-]+/g, "");
}

export function normalizeAssetName(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function normalizeHardKey(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toUpperCase();
}

function normalizedObservation(observation: AssetObservation) {
  return {
    assetClass: normalizeHardKey(observation.assetClass),
    rawCode: normalizeAssetCode(observation.rawCode),
    codeType: normalizeHardKey(observation.codeType),
    rawName: normalizeAssetName(observation.rawName),
    currency: normalizeHardKey(observation.currency),
    shareClass: normalizeHardKey(observation.shareClass),
    distributionMode: normalizeHardKey(observation.distributionMode),
  };
}

function sameHardKeys(observation: ReturnType<typeof normalizedObservation>, asset: AssetRegistryRecord): boolean {
  if (normalizeHardKey(asset.assetClass) !== observation.assetClass) return false;
  if (observation.assetClass !== "FUND") return true;
  return (
    normalizeHardKey(asset.currency) === observation.currency
    && normalizeHardKey(asset.shareClass) === observation.shareClass
    && normalizeHardKey(asset.distributionMode) === observation.distributionMode
  );
}

function uniqueAssetIds(records: Array<{ assetId: number }>): number[] {
  return [...new Set(records.map((item) => item.assetId))];
}

export function resolveAssetIdentity(
  observationInput: AssetObservation,
  registry: {
    assets: AssetRegistryRecord[];
    codes?: AssetCodeRecord[];
    mappings?: AssetAliasRecord[];
  },
): AssetIdentityResolution {
  const observation = normalizedObservation(observationInput);
  if (!observation.assetClass) {
    return { status: "UNRESOLVED", contractVersion: ASSET_IDENTITY_VERSION, reason: "missing_asset_class" };
  }
  if (
    observation.assetClass === "FUND"
    && (!observation.currency || !observation.shareClass || !observation.distributionMode)
  ) {
    return { status: "UNRESOLVED", contractVersion: ASSET_IDENTITY_VERSION, reason: "missing_fund_attrs" };
  }

  const assetsById = new Map(registry.assets.map((asset) => [asset.assetId, asset]));

  if (observation.rawCode) {
    const codeMatches = (registry.codes ?? []).filter((code) => {
      if (normalizeAssetCode(code.normalizedCode) !== observation.rawCode) return false;
      return !observation.codeType || normalizeHardKey(code.codeType) === observation.codeType;
    });
    const ids = uniqueAssetIds(codeMatches).filter((id) => {
      const asset = assetsById.get(id);
      return asset ? sameHardKeys(observation, asset) : false;
    });
    if (ids.length === 1) {
      return { status: "UNIQUE", assetId: ids[0], tier: 1, contractVersion: ASSET_IDENTITY_VERSION, evidence: "reliable_code" };
    }
    if (ids.length > 1) {
      return { status: "AMBIGUOUS", candidates: ids, contractVersion: ASSET_IDENTITY_VERSION, reason: "code_collision" };
    }
    if (codeMatches.length > 0) {
      return { status: "UNRESOLVED", contractVersion: ASSET_IDENTITY_VERSION, reason: "code_hard_key_mismatch" };
    }
  }

  if (observation.rawName) {
    const mappingMatches = (registry.mappings ?? []).filter(
      (mapping) => normalizeHardKey(mapping.assetClass) === observation.assetClass
        && normalizeAssetName(mapping.normalizedAlias) === observation.rawName,
    );
    if (mappingMatches.length > 0) {
      const ids = uniqueAssetIds(mappingMatches);
      const valid = ids.filter((id) => {
        const asset = assetsById.get(id);
        return asset ? sameHardKeys(observation, asset) : false;
      });
      if (valid.length === 1 && valid.length === ids.length) {
        return { status: "UNIQUE", assetId: valid[0], tier: 2, contractVersion: ASSET_IDENTITY_VERSION, evidence: "approved_mapping" };
      }
      if (valid.length > 1) {
        return { status: "AMBIGUOUS", candidates: valid, contractVersion: ASSET_IDENTITY_VERSION, reason: "mapping_multi_target" };
      }
      return { status: "UNRESOLVED", contractVersion: ASSET_IDENTITY_VERSION, reason: "mapping_integrity_error" };
    }

    const nameMatches = registry.assets.filter(
      (asset) => normalizeHardKey(asset.assetClass) === observation.assetClass
        && normalizeAssetName(asset.canonicalName) === observation.rawName
        && sameHardKeys(observation, asset),
    );
    const ids = uniqueAssetIds(nameMatches);
    if (ids.length === 1) {
      return { status: "UNIQUE", assetId: ids[0], tier: 3, contractVersion: ASSET_IDENTITY_VERSION, evidence: "normalized_name_exact_unique" };
    }
    if (ids.length > 1) {
      return { status: "AMBIGUOUS", candidates: ids, contractVersion: ASSET_IDENTITY_VERSION, reason: "name_multi_candidates" };
    }
  }

  return { status: "UNRESOLVED", contractVersion: ASSET_IDENTITY_VERSION, reason: "no_candidate" };
}
