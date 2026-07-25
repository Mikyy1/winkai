import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Upload-ID, X-Chunk-Index, X-Total-Chunks");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const uploadId = req.headers["x-upload-id"];
  const chunkIndex = parseInt(req.headers["x-chunk-index"] || "-1");
  const totalChunks = parseInt(req.headers["x-total-chunks"] || "0");

  if (!uploadId || chunkIndex < 0 || totalChunks <= 0) {
    return res.status(400).json({ error: "Missing headers: X-Upload-ID, X-Chunk-Index, X-Total-Chunks" });
  }

  try {
    const dir = path.join(os.tmpdir(), "wink-uploads", uploadId);
    await fsp.mkdir(dir, { recursive: true });

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      chunks.push(chunk);
      totalBytes += chunk.length;
    }
    const buffer = Buffer.concat(chunks);

    const chunkPath = path.join(dir, `chunk_${String(chunkIndex).padStart(4, "0")}`);
    await fsp.writeFile(chunkPath, buffer);

    const existing = await fsp.readdir(dir);
    const received = existing.filter(f => f.startsWith("chunk_")).length;

    console.log(`[upload] ${uploadId} chunk ${chunkIndex}/${totalChunks} (${(totalBytes/1024).toFixed(1)}KB) - received ${received}/${totalChunks}`);

    return res.status(200).json({
      success: true,
      chunkIndex,
      totalChunks,
      received,
      chunkSize: totalBytes,
    });
  } catch (err) {
    console.error("[upload] error:", err);
    return res.status(500).json({ error: err.message });
  }
}
