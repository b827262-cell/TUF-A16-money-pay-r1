import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { imports, ocrDocuments, positions } from "../../../db/schema";

export async function GET() {
  try {
    const db = getDb();
    const [positionRows, importRows, ocrRows] = await Promise.all([
      db.select().from(positions).orderBy(desc(positions.createdAt), desc(positions.id)),
      db.select().from(imports).orderBy(desc(imports.createdAt)).limit(20),
      db.select({ id: ocrDocuments.id, filename: ocrDocuments.filename, docType: ocrDocuments.docType, confidence: ocrDocuments.confidence, reviewStatus: ocrDocuments.reviewStatus, createdAt: ocrDocuments.createdAt }).from(ocrDocuments).orderBy(desc(ocrDocuments.createdAt)).limit(20),
    ]);
    return Response.json({ positions: positionRows, imports: importRows, ocrDocuments: ocrRows });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "資料讀取失敗" }, { status: 500 });
  }
}
