import { env } from "cloudflare:workers";

export async function POST(request: Request) {
  try {
    const { snapshotDate } = await request.json() as { snapshotDate?: string };
    if (!snapshotDate || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
      return Response.json({ error: "請提供 YYYY-MM-DD 格式的統計日期" }, { status: 400 });
    }
    const existing = await env.DB.prepare("SELECT id FROM portfolio_snapshots WHERE snapshot_date = ? LIMIT 1").bind(snapshotDate).first();
    if (existing) return Response.json({ error: "此日期已有統計快照，請改選其他日期" }, { status: 409 });

    const totals = await env.DB.prepare(`SELECT COUNT(*) AS position_count,
      COALESCE(SUM(cost_basis_twd), 0) AS cost_basis_twd,
      COALESCE(SUM(market_value_twd), 0) AS market_value_twd,
      COALESCE(SUM(pnl_twd), 0) AS pnl_twd,
      COALESCE(SUM(dividend_twd), 0) AS dividend_twd FROM positions`).first<{
        position_count: number; cost_basis_twd: number; market_value_twd: number; pnl_twd: number; dividend_twd: number;
      }>();
    if (!totals?.position_count) return Response.json({ error: "尚無持倉資料，無法建立快照" }, { status: 400 });

    const saved = await env.DB.prepare(`INSERT INTO portfolio_snapshots
      (snapshot_date, position_count, cost_basis_twd, market_value_twd, pnl_twd, dividend_twd)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(snapshotDate, totals.position_count, totals.cost_basis_twd, totals.market_value_twd, totals.pnl_twd, totals.dividend_twd)
      .first<{ id: number }>();
    return Response.json({ id: saved?.id, snapshotDate, totals }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "建立統計快照失敗" }, { status: 500 });
  }
}
