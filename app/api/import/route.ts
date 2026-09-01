import { env } from "cloudflare:workers";
import { findImportByContent, parseAsOfDate, PARSER_VERSION, PortfolioQueryError, todayInTaipei } from "@/lib/portfolio";
import { classifyPosition } from "@/lib/position-classification";

type CanonicalRow = {
  assetCode?: string; assetName: string; assetType: string; currency?: string;
  units?: number; avgCost?: number; marketPrice?: number; costBasisTwd?: number;
  marketValueTwd?: number; pnlTwd?: number; returnPct?: number; dividendTwd?: number;
  valuationDate?: string; raw?: Record<string, string>;
};

type ImportPayload = {
  filename?: string; fileHash?: string; sourceKind?: string; asOfDate?: string; rows?: CanonicalRow[];
};

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

    const existing = await findImportByContent(env.DB, { fileHash, sourceKind, asOfDate });
    if (existing?.status === "applied") return Response.json({ error: "這份檔案已匯入，不會重複計算", importId: existing.id }, { status: 409 });

    // A batch that never reached `applied` owns no positions, so resume it instead of leaving a second row behind.
    let importId = existing?.id;
    if (!importId) {
      const inserted = await env.DB.prepare(`INSERT INTO imports (filename, file_hash, source_kind, row_count, as_of_date, status, parser_version)
        VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING id`)
        .bind(filename, fileHash, sourceKind, rows.length, asOfDate, PARSER_VERSION).first<{ id: number }>();
      importId = inserted?.id;
    }
    if (!importId) throw new Error("無法建立匯入批次");

    const statements = rows.map((row) => {
      const classification = classifyPosition({ assetCode: row.assetCode, assetType: row.assetType, assetName: row.assetName, raw: row.raw ?? {} });
      return env.DB.prepare(`INSERT INTO positions
        (import_id, asset_code, asset_name, asset_type, currency, units, avg_cost, market_price, cost_basis_twd, market_value_twd, pnl_twd, return_pct, dividend_twd, valuation_date,
         last_purchase_date, purchase_date_basis, asset_category, invest_region, market_cap_tier, invest_style, industry_theme, risk_reward_level, source_kind, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(importId, row.assetCode ?? null, row.assetName, row.assetType, row.currency ?? "TWD", row.units ?? 0, row.avgCost ?? 0, row.marketPrice ?? 0,
          row.costBasisTwd ?? 0, row.marketValueTwd ?? 0, row.pnlTwd ?? 0, row.returnPct ?? 0, row.dividendTwd ?? 0, row.valuationDate ?? null,
          classification.lastPurchaseDate, classification.purchaseDateBasis, classification.assetCategory, classification.investRegion,
          classification.marketCapTier, classification.investStyle, classification.industryTheme, classification.riskRewardLevel, sourceKind, JSON.stringify(row.raw ?? {}));
    });

    // D1 runs one batch inside a single implicit transaction: the rows and the applied flag land together.
    statements.push(env.DB.prepare("UPDATE imports SET status = 'applied', as_of_date = ?, row_count = ?, parser_version = ? WHERE id = ?")
      .bind(asOfDate, rows.length, PARSER_VERSION, importId));
    await env.DB.batch(statements);

    return Response.json({ imported: rows.length, importId, asOfDate, status: "applied" }, { status: 201 });
  } catch (error) {
    if (error instanceof PortfolioQueryError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "匯入失敗" }, { status: 500 });
  }
}
