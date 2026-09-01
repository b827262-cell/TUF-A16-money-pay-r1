import { env } from "cloudflare:workers";
import { comparePackageCoverageAsOf, comparePortfolioAsOf, parseAsOfDate, PortfolioQueryError } from "@/lib/portfolio";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const from = parseAsOfDate(params.get("from"), { required: true });
    const to = parseAsOfDate(params.get("to"), { required: true });
    const scope = params.get("scope") ?? "production";
    if (scope !== "production" && scope !== "package") {
      return Response.json({ error: "比較範圍只能是 production 或 package" }, { status: 400 });
    }
    const comparison = scope === "package"
      ? await comparePackageCoverageAsOf(env.DB, from, to)
      : await comparePortfolioAsOf(env.DB, from, to);
    return Response.json({ ...comparison, scope });
  } catch (error) {
    if (error instanceof PortfolioQueryError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "日期比較失敗" }, { status: 500 });
  }
}
