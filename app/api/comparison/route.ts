import { env } from "cloudflare:workers";
import { comparePortfolioAsOf, parseAsOfDate, PortfolioQueryError } from "@/lib/portfolio";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const from = parseAsOfDate(params.get("from"), { required: true });
    const to = parseAsOfDate(params.get("to"), { required: true });
    return Response.json(await comparePortfolioAsOf(env.DB, from, to));
  } catch (error) {
    if (error instanceof PortfolioQueryError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "日期比較失敗" }, { status: 500 });
  }
}
