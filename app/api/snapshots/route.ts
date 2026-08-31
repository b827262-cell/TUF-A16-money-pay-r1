import { env } from "cloudflare:workers";
import { getPortfolioAsOf, parseAsOfDate, PortfolioQueryError } from "@/lib/portfolio";

export async function POST(request: Request) {
  try {
    const { snapshotDate: rawDate } = await request.json() as { snapshotDate?: string };
    const snapshotDate = parseAsOfDate(rawDate, { required: true });

    const existing = await env.DB.prepare("SELECT id FROM portfolio_snapshots WHERE snapshot_date = ? LIMIT 1").bind(snapshotDate).first();
    if (existing) return Response.json({ error: "此日期已有統計快照，請改選其他日期" }, { status: 409 });

    // Only the imports that were current on that date count, so later uploads cannot inflate the record.
    const portfolio = await getPortfolioAsOf(env.DB, snapshotDate);
    if (!portfolio.totals.positionCount) return Response.json({ error: "該日期尚無已套用的持倉資料，無法建立快照" }, { status: 400 });

    const saved = await env.DB.prepare(`INSERT INTO portfolio_snapshots
      (snapshot_date, position_count, cost_basis_twd, market_value_twd, pnl_twd, dividend_twd)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(snapshotDate, portfolio.totals.positionCount, portfolio.totals.costBasisTwd, portfolio.totals.marketValueTwd, portfolio.totals.pnlTwd, portfolio.totals.dividendTwd)
      .first<{ id: number }>();
    return Response.json({ id: saved?.id, snapshotDate, totals: portfolio.totals, importsUsed: portfolio.importsUsed }, { status: 201 });
  } catch (error) {
    if (error instanceof PortfolioQueryError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "建立統計快照失敗" }, { status: 500 });
  }
}
