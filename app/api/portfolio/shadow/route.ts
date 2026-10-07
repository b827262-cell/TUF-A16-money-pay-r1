import { env } from "cloudflare:workers";
import { getShadowPortfolioAsOf, parseAsOfDate, PortfolioQueryError } from "@/lib/portfolio";

export async function GET(request: Request) {
  try {
    const asOfDate = parseAsOfDate(new URL(request.url).searchParams.get("asOf"));
    const portfolio = await getShadowPortfolioAsOf(env.DB, asOfDate);
    return Response.json({ ...portfolio, mode: "p2-shadow", cutover: false });
  } catch (error) {
    if (error instanceof PortfolioQueryError) return Response.json({ error: error.message, mode: "p2-shadow" }, { status: 409 });
    return Response.json({ error: error instanceof Error ? error.message : "Shadow 資料讀取失敗" }, { status: 500 });
  }
}
