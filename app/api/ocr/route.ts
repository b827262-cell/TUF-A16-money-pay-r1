import { env } from "cloudflare:workers";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const rawText = String(form.get("rawText") ?? "").trim();
    const extractedJson = String(form.get("extractedJson") ?? "{}");
    const docType = String(form.get("docType") ?? "investment_screenshot");
    const confidence = Number(form.get("confidence") ?? 0);
    if (!(file instanceof File) || !rawText) return Response.json({ error: "請提供圖片與校對文字" }, { status: 400 });
    if (file.size > 10 * 1024 * 1024) return Response.json({ error: "圖片不可超過 10MB" }, { status: 400 });
    JSON.parse(extractedJson);

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectKey = `ocr/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
    await env.BUCKET.put(objectKey, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    const saved = await env.DB.prepare(`INSERT INTO ocr_documents
      (object_key, filename, doc_type, raw_text, extracted_json, confidence, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(objectKey, file.name, docType, rawText, extractedJson, Number.isFinite(confidence) ? confidence : 0, "reviewed").first<{ id: number }>();
    return Response.json({ id: saved?.id }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OCR 資料儲存失敗" }, { status: 500 });
  }
}
