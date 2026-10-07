import { env } from "cloudflare:workers";
import { findImportByContent, parseAsOfDate, PARSER_VERSION, PortfolioQueryError, todayInTaipei } from "@/lib/portfolio";
import { buildCanonicalContentHash, buildLogicalImportKey, LOGICAL_IMPORT_KEY_VERSION, resolveSupersedesWinner, sourceContractFor } from "@/lib/p2-contracts";
import { classifyPosition } from "@/lib/position-classification";

type CanonicalRow = {
  assetCode?: string; assetName: string; assetType: string; currency?: string;
  units?: number; avgCost?: number; marketPrice?: number; costBasisTwd?: number;
  marketValueTwd?: number; pnlTwd?: number; returnPct?: number; dividendTwd?: number;
  valuationDate?: string; raw?: Record<string, string>;
};

type ImportPayload = {
  filename?: string;
  fileHash?: string;
  sourceKind?: string;
  asOfDate?: string;
  rows?: CanonicalRow[];
  accountKey?: string;
  accountKeyBasis?: "explicit" | "registered_mapping" | "legacy_unknown";
  scopeKey?: string;
  sourceRole?: "authoritative" | "supplemental" | "reconciliation";
  coverageType?: "full" | "partial" | "legacy_unknown";
  sourceNativeImportId?: string;
  sourceMappingKey?: string;
  supersedesImportId?: number;
};

type ImportGrainRow = {
  id: number;
  accountKey: string | null;
  scopeKey: string | null;
  asOfDate: string | null;
  sourceRole: string;
  supersedesImportId: number | null;
};

type LogicalImportRow = {
  id: number;
  status: string;
  fileHash: string;
  canonicalContentHash: string | null;
  accountKey: string | null;
  scopeKey: string | null;
  asOfDate: string | null;
  sourceRole: string;
  supersedesImportId: number | null;
};

function trimmed(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function hasP2Metadata(payload: ImportPayload): boolean {
  return [
    payload.accountKey,
    payload.accountKeyBasis,
    payload.scopeKey,
    payload.sourceRole,
    payload.coverageType,
    payload.sourceNativeImportId,
    payload.sourceMappingKey,
    payload.supersedesImportId,
  ].some((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

async function validateSupersedesChain(
  targetId: number,
  expected: { accountKey: string; scopeKey: string; asOfDate: string; sourceRole: string },
) {
  const visited = new Set<number>();
  let cursor: number | null = targetId;
  let depth = 0;
  while (cursor !== null) {
    if (visited.has(cursor)) throw new PortfolioQueryError("supersedes chain contains a cycle");
    if (++depth > 1000) throw new PortfolioQueryError("supersedes chain is too deep");
    visited.add(cursor);
    const row: ImportGrainRow | null = await env.DB.prepare(`SELECT id, account_key AS accountKey, scope_key AS scopeKey,
      as_of_date AS asOfDate, source_role AS sourceRole, supersedes_import_id AS supersedesImportId
      FROM imports WHERE id = ? LIMIT 1`).bind(cursor).first<ImportGrainRow>();
    if (!row) throw new PortfolioQueryError("supersedes target does not exist");
    if (
      row.accountKey !== expected.accountKey
      || row.scopeKey !== expected.scopeKey
      || row.asOfDate !== expected.asOfDate
      || row.sourceRole !== expected.sourceRole
    ) {
      throw new PortfolioQueryError("supersedes target must have the same account/scope/date/source_role");
    }
    cursor = row.supersedesImportId;
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as ImportPayload;
    const filename = payload.filename?.trim();
    const fileHash = payload.fileHash?.trim();
    const sourceKind = payload.sourceKind?.trim();
    const rows = payload.rows ?? [];
    const asOfDate = parseAsOfDate(payload.asOfDate) ?? todayInTaipei();
    if (!filename || !fileHash || !sourceKind || !rows.length) return Response.json({ error: "匯入資料不完整" }, { status: 400 });
    if (rows.length > 1000) return Response.json({ error: "單次最多匯入 1,000 筆" }, { status: 400 });

    const p2 = hasP2Metadata(payload);
    let accountKey: string | null = null;
    let accountKeyBasis: "explicit" | "registered_mapping" | "legacy_unknown" = "legacy_unknown";
    let scopeKey: string | null = null;
    let sourceRole: "authoritative" | "supplemental" | "reconciliation" = "supplemental";
    let coverageType: "full" | "partial" | "legacy_unknown" = "legacy_unknown";
    let sourceNativeImportId: string | null = null;
    let sourceMappingKey: string | null = null;
    let logicalImportKey: string | null = null;
    let logicalImportKeyVersion: string | null = null;
    let canonicalContentHash: string | null = null;
    let supersedesImportId: number | null = null;

    if (p2) {
      const missingCurrencyRow = rows.find((row) => !trimmed(row.currency));
      if (missingCurrencyRow) {
        return Response.json({ error: "P2 匯入每筆資料都必須明確提供 currency" }, { status: 400 });
      }

      const contract = sourceContractFor(sourceKind);
      const suppliedAccountKey = trimmed(payload.accountKey);
      const suppliedScope = trimmed(payload.scopeKey);
      sourceMappingKey = trimmed(payload.sourceMappingKey);
      accountKeyBasis = payload.accountKeyBasis
        ?? (sourceMappingKey ? "registered_mapping" : "explicit");

      if (accountKeyBasis === "legacy_unknown") {
        return Response.json({ error: "P2 匯入不可使用 legacy_unknown account_key_basis" }, { status: 400 });
      }
      if (accountKeyBasis !== "explicit" && accountKeyBasis !== "registered_mapping") {
        return Response.json({ error: "account_key_basis 無效" }, { status: 400 });
      }
      if (accountKeyBasis === "explicit" && sourceMappingKey) {
        return Response.json({ error: "source_mapping_key 只能搭配 registered_mapping" }, { status: 400 });
      }

      if (accountKeyBasis === "registered_mapping") {
        if (!sourceMappingKey) {
          return Response.json({ error: "registered_mapping 必須提供 source_mapping_key" }, { status: 400 });
        }
        const mapping = await env.DB.prepare(`SELECT account_key AS accountKey, scope_key AS scopeKey
          FROM account_source_mappings
          WHERE mapping_key = ? AND source_kind = ? AND status = 'approved'
            AND approved_by IS NOT NULL AND approved_at IS NOT NULL
          LIMIT 1`)
          .bind(sourceMappingKey, sourceKind)
          .first<{ accountKey: string; scopeKey: string }>();
        if (!mapping) {
          return Response.json({ error: "REGISTERED_MAPPING_NOT_APPROVED：找不到 Owner-approved source→account mapping" }, { status: 400 });
        }
        if (suppliedAccountKey && suppliedAccountKey !== mapping.accountKey) {
          return Response.json({ error: "account_key 與 approved registered mapping 不一致" }, { status: 400 });
        }
        if (suppliedScope && suppliedScope !== mapping.scopeKey) {
          return Response.json({ error: "scope_key 與 approved registered mapping 不一致" }, { status: 400 });
        }
        accountKey = mapping.accountKey;
        scopeKey = mapping.scopeKey;
      } else {
        accountKey = suppliedAccountKey;
        if (!accountKey) return Response.json({ error: "explicit P2 匯入必須提供 stable account_key" }, { status: 400 });
        scopeKey = suppliedScope ?? contract.scopeKey;
      }

      if (contract.scopeKey && scopeKey && scopeKey !== contract.scopeKey) {
        return Response.json({ error: `source_kind=${sourceKind} 的 scope_key 必須是 ${contract.scopeKey}` }, { status: 400 });
      }
      if (!scopeKey) return Response.json({ error: "P2 匯入必須提供可判定的 scope_key" }, { status: 400 });
      if (!accountKey) return Response.json({ error: "P2 匯入必須提供可判定的 account_key" }, { status: 400 });
      const resolvedAccountKey = accountKey;
      const resolvedScopeKey = scopeKey;

      sourceRole = payload.sourceRole ?? contract.sourceRole;
      if (sourceRole !== contract.sourceRole) {
        return Response.json({ error: `source_kind=${sourceKind} 的 source_role 必須是 ${contract.sourceRole}` }, { status: 400 });
      }
      if (!payload.coverageType) return Response.json({ error: "P2 匯入必須明確宣告 coverage_type" }, { status: 400 });
      coverageType = payload.coverageType;
      if (!["full", "partial", "legacy_unknown"].includes(coverageType)) {
        return Response.json({ error: "coverage_type 無效" }, { status: 400 });
      }
      if (sourceRole === "authoritative" && coverageType === "legacy_unknown") {
        return Response.json({ error: "authoritative P2 匯入不可宣告 legacy_unknown coverage" }, { status: 400 });
      }

      sourceNativeImportId = trimmed(payload.sourceNativeImportId);
      logicalImportKey = await buildLogicalImportKey({
        accountKey: resolvedAccountKey,
        scopeKey: resolvedScopeKey,
        sourceKind,
        logicalPeriodKey: asOfDate,
        sourceNativeImportId,
      });
      logicalImportKeyVersion = LOGICAL_IMPORT_KEY_VERSION;
      canonicalContentHash = await buildCanonicalContentHash(rows);

      if (payload.supersedesImportId !== undefined) {
        const candidate = Number(payload.supersedesImportId);
        if (!Number.isSafeInteger(candidate) || candidate <= 0) {
          return Response.json({ error: "supersedes_import_id 無效" }, { status: 400 });
        }
        supersedesImportId = candidate;
        await validateSupersedesChain(candidate, { accountKey: resolvedAccountKey, scopeKey: resolvedScopeKey, asOfDate, sourceRole });
      }

      const logicalRowsResult = await env.DB.prepare(`SELECT id, status, file_hash AS fileHash,
        canonical_content_hash AS canonicalContentHash,
        account_key AS accountKey, scope_key AS scopeKey, as_of_date AS asOfDate,
        source_role AS sourceRole, supersedes_import_id AS supersedesImportId
        FROM imports WHERE logical_import_key = ?`)
        .bind(logicalImportKey).all<LogicalImportRow>();
      const logicalRows: LogicalImportRow[] = logicalRowsResult.results ?? [];
      const sameContent = logicalRows.find((row) => row.canonicalContentHash === canonicalContentHash);
      if (sameContent?.status === "applied") {
        return Response.json({ error: "這個 logical_import_key + canonical_content_hash 已套用，不會重複計算", importId: sameContent.id }, { status: 409 });
      }
      if (!sameContent && logicalRows.length > 0) {
        if (supersedesImportId === null) {
          return Response.json({ error: "logical_import_key 已有不同內容；必須明確 supersedes 目前 terminal import" }, { status: 409 });
        }
        const appliedRows = logicalRows.filter((row) => row.status === "applied");
        const resolution = resolveSupersedesWinner(appliedRows.map((row) => ({
          id: row.id,
          accountKey: row.accountKey,
          scopeKey: row.scopeKey,
          asOfDate: row.asOfDate,
          sourceRole: row.sourceRole,
          supersedesImportId: row.supersedesImportId,
        })));
        if (resolution.status !== "UNIQUE" || resolution.winner.id !== supersedesImportId) {
          return Response.json({ error: "supersedes_import_id 必須指向同 logical_import_key 的唯一 terminal import" }, { status: 409 });
        }
      }
    }

    const existing = p2
      ? await env.DB.prepare(`SELECT id, status FROM imports
          WHERE file_hash = ? AND source_kind = ? AND as_of_date = ?
            AND account_key = ? AND scope_key = ?
          LIMIT 1`)
          .bind(fileHash, sourceKind, asOfDate, accountKey, scopeKey)
          .first<{ id: number; status: "pending" | "applied" }>()
      : await findImportByContent(env.DB, { fileHash, sourceKind, asOfDate });
    if (existing?.status === "applied") return Response.json({ error: "這份檔案已匯入，不會重複計算", importId: existing.id }, { status: 409 });

    // A pending batch may only be resumed when it belongs to the same validated grain.
    let importId = existing?.id;
    if (!importId) {
      const inserted = await env.DB.prepare(`INSERT INTO imports
        (filename, file_hash, source_kind, row_count, as_of_date, status, parser_version,
         account_key, account_key_basis, scope_key, source_role, coverage_type,
         logical_import_key, logical_import_key_version, canonical_content_hash, source_native_import_id, source_mapping_key, supersedes_import_id)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .bind(
          filename, fileHash, sourceKind, rows.length, asOfDate, PARSER_VERSION,
          accountKey, accountKeyBasis, scopeKey, sourceRole, coverageType,
          logicalImportKey, logicalImportKeyVersion, canonicalContentHash, sourceNativeImportId, sourceMappingKey, supersedesImportId,
        ).first<{ id: number }>();
      importId = inserted?.id;
    }
    if (!importId) throw new Error("無法建立匯入批次");

    const statements = rows.map((row) => {
      const classification = classifyPosition({ assetCode: row.assetCode, assetType: row.assetType, assetName: row.assetName, raw: row.raw ?? {} });
      return env.DB.prepare(`INSERT INTO positions
        (import_id, asset_code, asset_name, asset_type, currency, units, avg_cost, market_price, cost_basis_twd, market_value_twd, pnl_twd, return_pct, dividend_twd, valuation_date,
         last_purchase_date, purchase_date_basis, asset_category, invest_region, market_cap_tier, invest_style, industry_theme, risk_reward_level, source_kind, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(importId, row.assetCode ?? null, row.assetName, row.assetType, row.currency ?? "TWD", row.units ?? 0, row.avgCost ?? 0, row.marketPrice ?? 0,
          row.costBasisTwd ?? 0, row.marketValueTwd ?? 0, row.pnlTwd ?? 0, row.returnPct ?? 0, row.dividendTwd ?? 0, row.valuationDate ?? null,
          classification.lastPurchaseDate, classification.purchaseDateBasis, classification.assetCategory, classification.investRegion,
          classification.marketCapTier, classification.investStyle, classification.industryTheme, classification.riskRewardLevel, sourceKind, JSON.stringify(row.raw ?? {}));
    });

    statements.push(env.DB.prepare(`UPDATE imports SET status = 'applied', as_of_date = ?, row_count = ?, parser_version = ?,
      account_key = ?, account_key_basis = ?, scope_key = ?, source_role = ?, coverage_type = ?,
      logical_import_key = ?, logical_import_key_version = ?, canonical_content_hash = ?, source_native_import_id = ?, source_mapping_key = ?, supersedes_import_id = ?
      WHERE id = ?`)
      .bind(
        asOfDate, rows.length, PARSER_VERSION,
        accountKey, accountKeyBasis, scopeKey, sourceRole, coverageType,
        logicalImportKey, logicalImportKeyVersion, canonicalContentHash, sourceNativeImportId, sourceMappingKey, supersedesImportId,
        importId,
      ));
    await env.DB.batch(statements);

    return Response.json({
      imported: rows.length,
      importId,
      asOfDate,
      status: "applied",
      p2Contract: p2 ? {
        accountKey,
        scopeKey,
        sourceRole,
        coverageType,
        logicalImportKey,
        logicalImportKeyVersion,
        canonicalContentHash,
        sourceMappingKey,
        supersedesImportId,
      } : null,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof PortfolioQueryError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "匯入失敗" }, { status: 500 });
  }
}
