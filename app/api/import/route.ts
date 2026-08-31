import { env } from "cloudflare:workers";

type CanonicalRow = {
  assetCode?: string; assetName: string; assetType: string; currency?: string;
  units?: number; avgCost?: number; marketPrice?: number; costBasisTwd?: number;
  marketValueTwd?: number; pnlTwd?: number; returnPct?: number; dividendTwd?: number;
  valuationDate?: string; raw?: Record<string, string>;
};

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { filename?: string; fileHash?: string; sourceKind?: string; rows?: CanonicalRow[] };
    const filename = payload.filename?.trim();
    const fileHash = payload.fileHash?.trim();
    const rows = payload.rows ?? [];
    if (!filename || !fileHash || !payload.sourceKind || !rows.length) return Response.json({ error: "匯入資料不完整" }, { status: 400 });
    if (rows.length > 1000) return Response.json({ error: "單次最多匯入 1,000 筆" }, { status: 400 });

    const existing = await env.DB.prepare("SELECT id FROM imports WHERE file_hash = ? LIMIT 1").bind(fileHash).first();
    if (existing) return Response.json({ error: "這份檔案已匯入，不會重複計算" }, { status: 409 });

    const inserted = await env.DB.prepare("INSERT INTO imports (filename, file_hash, source_kind, row_count) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(filename, fileHash, payload.sourceKind, rows.length).first<{ id: number }>();
    if (!inserted?.id) throw new Error("無法建立匯入批次");

    const statements = rows.map((row) => env.DB.prepare(`INSERT INTO positions
      (import_id, asset_code, asset_name, asset_type, currency, units, avg_cost, market_price, cost_basis_twd, market_value_twd, pnl_twd, return_pct, dividend_twd, valuation_date, source_kind, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(inserted.id, row.assetCode ?? null, row.assetName, row.assetType, row.currency ?? "TWD", row.units ?? 0, row.avgCost ?? 0, row.marketPrice ?? 0, row.costBasisTwd ?? 0, row.marketValueTwd ?? 0, row.pnlTwd ?? 0, row.returnPct ?? 0, row.dividendTwd ?? 0, row.valuationDate ?? null, payload.sourceKind, JSON.stringify(row.raw ?? {})));
    await env.DB.batch(statements);
    return Response.json({ imported: rows.length }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "匯入失敗" }, { status: 500 });
  }
}
