import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { ocrDocuments } from "../../../db/schema";
import { getPortfolioAsOf, listAppliedDates, listImportHistory, parseAsOfDate, PortfolioQueryError } from "@/lib/portfolio";

export async function GET(request: Request) {
  try {
    const asOfDate = parseAsOfDate(new URL(request.url).searchParams.get("asOf"));
    const db = getDb();
    const [portfolio, importRows, ocrRows, availableDates] = await Promise.all([
      getPortfolioAsOf(env.DB, asOfDate),
      listImportHistory(env.DB),
      db.select({ id: ocrDocuments.id, filename: ocrDocuments.filename, docType: ocrDocuments.docType, confidence: ocrDocuments.confidence, reviewStatus: ocrDocuments.reviewStatus, createdAt: ocrDocuments.createdAt }).from(ocrDocuments).where(eq(ocrDocuments.reviewStatus, "reviewed")).orderBy(desc(ocrDocuments.createdAt)).limit(20),
      listAppliedDates(env.DB),
    ]);
    return Response.json({
      ...portfolio,
      imports: importRows,
      ocrDocuments: ocrRows,
      availableDates,
    });
  } catch (error) {
    if (error instanceof PortfolioQueryError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "資料讀取失敗" }, { status: 500 });
  }
}
