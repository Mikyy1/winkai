import axios from "axios";
import FormData from "form-data";
import crypto from "node:crypto";
import path from "node:path";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import multer from "multer";

// ─── Constants ───────────────────────────────────────────────
const BASE_URL = "https://wink.ai";
const STRATEGY_URL = "https://strategy.app.meitudata.com";
const CLIENT_ID = "1189857605";
const VERSION = "5.1.2";
const COUNTRY_CODE = "ID";
const CLIENT_LANGUAGE = "en_US";
const CLIENT_TIMEZONE = "Asia/Jakarta";
const TASK_TYPE = "11";
const CONTENT_TYPE = "2";
const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

// ─── Multer (memory storage) ─────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});
const uploadMiddleware = upload.single("video");

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) =>
      result instanceof Error ? reject(result) : resolve(result)
    );
  });
}

// ─── Helpers ─────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTrace() {
  return `${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-1`;
}

function traceHeaders() {
  const trace = makeTrace();
  return {
    "sentry-trace": trace,
    baggage: [
      "sentry-environment=release",
      "sentry-release=5.1.2%20(b60d25c477f43c6dfac4107810f26d442320f4f1)",
      "sentry-public_key=e1bf914f3448d9bc8a10c7e499d17d54",
      `sentry-trace_id=${trace.split("-")[0]}`,
      "sentry-sampled=true",
      "sentry-sample_rate=0.75",
    ].join(","),
  };
}

function extToMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return (
    {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
    }[ext] || "application/octet-stream"
  );
}

function baseParams(gnum, extra = {}) {
  return new URLSearchParams({
    client_id: CLIENT_ID,
    version: VERSION,
    country_code: COUNTRY_CODE,
    gnum,
    client_language: CLIENT_LANGUAGE,
    client_channel_id: "",
    client_timezone: CLIENT_TIMEZONE,
    ...extra,
  });
}

function createApiClient(gnum, jar) {
  return wrapper(
    axios.create({
      baseURL: BASE_URL,
      jar,
      withCredentials: true,
      validateStatus: () => true,
      headers: {
        accept: "*/*",
        origin: BASE_URL,
        referer: `${BASE_URL}/video-enhancer/upload`,
        "user-agent": UA,
        "sec-ch-ua":
          '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"Android"',
        ab_info: JSON.stringify({ ab_codes: [], version: "1.4.4" }),
      },
    })
  );
}

// ─── SSE sender ──────────────────────────────────────────────
function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

// ─── Wink API Functions ──────────────────────────────────────
async function getMaatSign(client, gnum) {
  const params = baseParams(gnum, { suffix: ".mp4", type: "temp", count: "1" });
  const res = await client.get(`/api/file/get_maat_sign.json?${params}`, {
    headers: traceHeaders(),
  });
  if (res.status >= 400 || res.data?.code !== 0)
    throw new Error(`get_maat_sign gagal: ${JSON.stringify(res.data)}`);
  return res.data.data;
}

async function getUploadPolicy(sign) {
  const params = new URLSearchParams({
    app: sign.app,
    count: String(sign.count),
    sig: sign.sig,
    sigTime: sign.sig_time,
    sigVersion: sign.sig_version,
    suffix: sign.suffix,
    type: sign.type,
  });
  const res = await axios.get(`${STRATEGY_URL}/upload/policy?${params}`, {
    headers: { accept: "*/*", origin: BASE_URL, referer: `${BASE_URL}/`, "user-agent": UA },
    validateStatus: () => true,
  });
  if (res.status >= 400 || !Array.isArray(res.data) || !res.data[0]?.qiniu)
    throw new Error(`upload policy gagal`);
  return res.data[0].qiniu;
}

async function uploadToQiniu(policy, fileBuffer, filename, onProgress) {
  const form = new FormData();
  form.append("file", fileBuffer, { filename, contentType: extToMime(filename) });
  form.append("token", policy.token);
  form.append("key", policy.key);
  form.append("fname", filename);

  const total = fileBuffer.length;
  const res = await axios.post(policy.url, form, {
    headers: form.getHeaders({ origin: BASE_URL, referer: `${BASE_URL}/`, "user-agent": UA, accept: "*/*" }),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
    onUploadProgress: (p) => {
      if (p.total && onProgress) {
        const pct = Math.round((p.loaded / p.total) * 100);
        onProgress(pct);
      }
    },
  });
  if (res.status >= 400) throw new Error(`upload qiniu gagal HTTP ${res.status}`);
  return {
    file_key: policy.key,
    source_url: res.data.url || res.data.data || policy.data,
    raw: res.data,
  };
}

async function getVideoInfo(client, gnum, fileKey) {
  const body = baseParams(gnum, { file_key: fileKey });
  const res = await client.post(
    "/api/file/video_cover_and_display_info_ext.json",
    body.toString(),
    { headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } }
  );
  if (res.status >= 400 || res.data?.code !== 0)
    throw new Error(`video info gagal: ${JSON.stringify(res.data)}`);
  return res.data.data;
}

async function startTranscode(client, gnum, fileKey) {
  const body = baseParams(gnum, { file_key: fileKey });
  const res = await client.post("/api/file/video_trans_start.json", body.toString(), {
    headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  if (res.status >= 400 || res.data?.code !== 0 || !res.data?.data?.id)
    throw new Error(`transcode start gagal`);
  return res.data.data.id;
}

async function queryTranscode(client, gnum, id) {
  const params = baseParams(gnum, { id });
  const res = await client.get(`/api/file/video_trans_query.json?${params}`, {
    headers: traceHeaders(),
  });
  if (res.status >= 400 || res.data?.code !== 0)
    throw new Error(`transcode query gagal`);
  return res.data.data;
}

async function waitTranscode(client, gnum, id, fallback, res) {
  for (let i = 0; i < 60; i++) {
    const data = await queryTranscode(client, gnum, id);
    const video = data?.video || data?.url || data?.source_url || "";
    const transcoded =
      data?.video_transcoded || data?.transcoded_video ||
      data?.transcoded_url || data?.video_url || "";
    sendEvent(res, "progress", { step: "transcode", attempt: i + 1 });
    if (transcoded) return { source_url: video || fallback, video_transcoded: transcoded };
    await sleep(3000);
  }
  return { source_url: fallback, video_transcoded: fallback };
}

async function delivery(client, gnum, sourceUrl, videoTranscoded, taskName) {
  const body = baseParams(gnum, {
    type: TASK_TYPE,
    content_type: CONTENT_TYPE,
    source_url: sourceUrl,
    type_params: JSON.stringify({ is_mirror: 0, orientation_tag: 1, j_420_trans: "1", return_ext: "2" }),
    right_detail: JSON.stringify({
      source: "1", touch_type: "4", function_id: "630", material_id: "63011",
      url: "https://wink.ai/video-enhancer/upload",
    }),
    ext_params: JSON.stringify({
      task_name: taskName, records: TASK_TYPE, video_transcoded: videoTranscoded,
    }),
    with_prepare: "1",
  });
  const r = await client.post("/api/meitu_ai/delivery.json", body.toString(), {
    headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  if (r.status >= 400 || r.data?.code !== 0)
    throw new Error(`delivery gagal: ${JSON.stringify(r.data)}`);
  return r.data.data || {};
}

async function queryBatch(client, gnum, msgId) {
  const params = baseParams(gnum, { msg_ids: msgId });
  const res = await client.get(`/api/meitu_ai/query_batch.json?${params}`, {
    headers: { ...traceHeaders(), referer: `${BASE_URL}/video-enhancer/upload` },
  });
  if (res.status >= 400 || res.data?.code !== 0)
    throw new Error(`query batch gagal`);
  return res.data.data;
}

function extractResultUrl(data) {
  const item = data?.item_list?.[0];
  const media = item?.result?.media_info_list?.[0];
  return media?.media_data || item?.result?.result_url || item?.result?.url ||
    item?.client_ext_params?.video_transcoded || "";
}

function extractNextMsgId(data, currentMsgId) {
  const item = data?.item_list?.[0];
  const resultValue = item?.result?.result || "";
  const realMsgId = item?.result?.msg_id || item?.msg_id || "";
  if (resultValue && resultValue !== currentMsgId && !resultValue.startsWith("http")) return resultValue;
  if (realMsgId && realMsgId !== currentMsgId && !realMsgId.startsWith("wpr_")) return realMsgId;
  return "";
}

async function waitResult(client, gnum, firstMsgId, res) {
  let msgId = firstMsgId;
  for (let i = 0; i < 60; i++) {
    const data = await queryBatch(client, gnum, msgId);
    const next = extractNextMsgId(data, msgId);
    if (next) { msgId = next; await sleep(1000); continue; }
    const url = extractResultUrl(data);
    const errCode = data?.item_list?.[0]?.result?.error_code;
    const errMsg = data?.item_list?.[0]?.result?.error_msg;
    sendEvent(res, "progress", { step: "enhance", attempt: i + 1 });
    if (url && url.startsWith("http") && errCode === 0) return url;
    if (errCode && errCode !== 29901 && errCode !== 0)
      throw new Error(`task gagal: ${errCode} ${errMsg || ""}`);
    await sleep(5000);
  }
  throw new Error("result timeout");
}

// ─── Handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    await runMiddleware(req, res, uploadMiddleware);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (!req.file)
    return res.status(400).json({ error: "File video diperlukan" });

  // Setup SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  try {
    const filename = req.file.originalname || `video-${Date.now()}.mp4`;
    const fileBuffer = req.file.buffer;
    const taskName = `Enhancer-Ultra HD-${path.parse(filename).name}`;

    sendEvent(res, "progress", { step: "init", message: "Memulai sesi..." });

    const gnum = crypto.randomUUID();
    const jar = new CookieJar();
    await jar.setCookie(`_sm=${gnum}; Path=/; Domain=wink.ai`, BASE_URL);
    await jar.setCookie(
      `meitustat=${encodeURIComponent(JSON.stringify({ wgid: gnum }))}; Path=/; Domain=wink.ai`,
      BASE_URL
    );
    const client = createApiClient(gnum, jar);

    sendEvent(res, "progress", { step: "sign", message: "Mengambil upload token..." });
    const sign = await getMaatSign(client, gnum);

    sendEvent(res, "progress", { step: "policy", message: "Mengambil upload policy..." });
    const policy = await getUploadPolicy(sign);

    sendEvent(res, "progress", { step: "upload", message: "Mengupload video...", pct: 0 });
    const uploaded = await uploadToQiniu(policy, fileBuffer, filename, (pct) => {
      sendEvent(res, "progress", { step: "upload", pct });
    });

    sendEvent(res, "progress", { step: "info", message: "Memproses metadata video..." });
    await getVideoInfo(client, gnum, uploaded.file_key);

    sendEvent(res, "progress", { step: "transcode_start", message: "Memulai transcode..." });
    const transcodeId = await startTranscode(client, gnum, uploaded.file_key);
    const transcode = await waitTranscode(client, gnum, transcodeId, uploaded.source_url, res);

    sendEvent(res, "progress", { step: "delivery", message: "Mengirim ke AI Enhancer..." });
    const task = await delivery(
      client, gnum, transcode.source_url, transcode.video_transcoded, taskName
    );
    const firstMsgId = task.msg_id || task.prepare_msg_id;
    if (!firstMsgId) throw new Error("delivery gagal: tidak ada msg_id");

    sendEvent(res, "progress", { step: "enhance", message: "AI sedang memproses video..." });
    const resultUrl = await waitResult(client, gnum, firstMsgId, res);

    sendEvent(res, "result", { success: true, resultUrl, filename });
    res.end();
  } catch (err) {
    console.error("Enhance error:", err);
    sendEvent(res, "error", { message: err.message || "Internal error" });
    res.end();
  }
}

export const config = {
  api: { bodyParser: false },
};
