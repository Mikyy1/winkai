import axios from "axios";
import FormData from "form-data";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

const BASE_URL = "https://wink.ai";
const STRATEGY_URL = "https://strategy.app.meitudata.com";
const CLIENT_ID = "1189857605";
const VERSION = "5.1.2";
const COUNTRY_CODE = "ID";
const CLIENT_LANGUAGE = "en_US";
const CLIENT_TIMEZONE = "Asia/Jakarta";
const TASK_TYPE = "11";
const CONTENT_TYPE = "2";
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

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

function extToMime(f) {
  const e = path.extname(f).toLowerCase();
  return { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" }[e] || "application/octet-stream";
}

function baseParams(gnum, extra = {}) {
  return new URLSearchParams({ client_id: CLIENT_ID, version: VERSION, country_code: COUNTRY_CODE, gnum, client_language: CLIENT_LANGUAGE, client_channel_id: "", client_timezone: CLIENT_TIMEZONE, ...extra });
}

function createApiClient(gnum, jar) {
  return wrapper(axios.create({
    baseURL: BASE_URL, jar, withCredentials: true, validateStatus: () => true,
    headers: {
      accept: "*/*", origin: BASE_URL, referer: `${BASE_URL}/video-enhancer/upload`,
      "user-agent": UA, "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      "sec-ch-ua-mobile": "?1", "sec-ch-ua-platform": '"Android"',
      ab_info: JSON.stringify({ ab_codes: [], version: "1.4.4" }),
    },
  }));
}

function sendEvent(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

function sendLog(res, level, message, detail = null) {
  const ts = new Date().toISOString().slice(11, 23);
  sendEvent(res, "log", { level, message, detail: detail ? safeStr(detail) : null, ts });
  console.log(`[${ts}] [${level}] ${message}`, detail ? safeStr(detail).slice(0, 300) : "");
}

function safeStr(obj) {
  try { return typeof obj === "string" ? obj : JSON.stringify(obj); } catch { return String(obj); }
}

async function downloadToTmp(url, res) {
  sendLog(res, "info", `Downloading video from temp storage: ${url.slice(0, 80)}...`);
  const tmpPath = path.join(os.tmpdir(), `wink-${crypto.randomUUID()}.mp4`);
  const r = await axios.get(url, { responseType: "stream", timeout: 60000, headers: { "user-agent": UA } });
  const size = parseInt(r.headers["content-length"] || "0");
  sendLog(res, "info", `File size: ${(size/1024/1024).toFixed(2)} MB`);
  let downloaded = 0;
  const writer = fs.createWriteStream(tmpPath);
  r.data.on("data", (chunk) => {
    downloaded += chunk.length;
    const pct = size ? Math.round((downloaded / size) * 100) : 0;
    if (pct % 20 === 0) sendEvent(res, "progress", { step: "download", pct });
  });
  r.data.pipe(writer);
  await new Promise((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); });
  sendLog(res, "success", `Downloaded to ${tmpPath} (${(downloaded/1024/1024).toFixed(2)} MB)`);
  return tmpPath;
}

async function getMaatSign(client, gnum, res) {
  sendLog(res, "info", "Requesting upload sign from wink.ai...");
  const params = baseParams(gnum, { suffix: ".mp4", type: "temp", count: "1" });
  const r = await client.get(`/api/file/get_maat_sign.json?${params}`, { headers: traceHeaders() });
  if (r.status >= 400 || r.data?.code !== 0) {
    sendLog(res, "error", "get_maat_sign FAILED", { status: r.status, response: r.data });
    throw new Error(`get_maat_sign gagal: HTTP ${r.status}, code=${r.data?.code}`);
  }
  sendLog(res, "success", "Upload sign OK", { app: r.data.data?.app });
  return r.data.data;
}

async function getUploadPolicy(sign, res) {
  sendLog(res, "info", "Requesting upload policy from strategy server...");
  const params = new URLSearchParams({
    app: sign.app, count: String(sign.count), sig: sign.sig,
    sigTime: sign.sig_time, sigVersion: sign.sig_version, suffix: sign.suffix, type: sign.type,
  });
  const r = await axios.get(`${STRATEGY_URL}/upload/policy?${params}`, {
    headers: { accept: "*/*", origin: BASE_URL, referer: `${BASE_URL}/`, "user-agent": UA },
    validateStatus: () => true,
  });
  if (r.status >= 400 || !Array.isArray(r.data) || !r.data[0]?.qiniu) {
    sendLog(res, "error", "getUploadPolicy FAILED", { status: r.status, response: r.data });
    throw new Error(`upload policy gagal: HTTP ${r.status}`);
  }
  sendLog(res, "success", "Upload policy OK", { url: r.data[0].qiniu.url, key: r.data[0].qiniu.key });
  return r.data[0].qiniu;
}

async function uploadToQiniu(policy, filePath, filename, res) {
  sendLog(res, "info", `Uploading ${filename} to Qiniu CDN...`);
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), { filename, contentType: extToMime(filename) });
  form.append("token", policy.token);
  form.append("key", policy.key);
  form.append("fname", filename);
  const r = await axios.post(policy.url, form, {
    headers: form.getHeaders({ origin: BASE_URL, referer: `${BASE_URL}/`, "user-agent": UA, accept: "*/*" }),
    maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true,
    onUploadProgress: (p) => { if (p.total) sendEvent(res, "progress", { step: "upload", pct: Math.round((p.loaded/p.total)*100) }); },
  });
  if (r.status >= 400) {
    sendLog(res, "error", "Qiniu upload FAILED", { status: r.status, response: r.data });
    throw new Error(`upload qiniu gagal HTTP ${r.status}`);
  }
  sendLog(res, "success", "Qiniu upload OK", { response: r.data });
  return { file_key: policy.key, source_url: r.data.url || r.data.data || policy.data, raw: r.data };
}

async function getVideoInfo(client, gnum, fileKey, res) {
  sendLog(res, "info", `Fetching video info for key: ${fileKey}`);
  const body = baseParams(gnum, { file_key: fileKey });
  const r = await client.post("/api/file/video_cover_and_display_info_ext.json", body.toString(), {
    headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }
  });
  if (r.status >= 400 || r.data?.code !== 0) {
    sendLog(res, "error", "getVideoInfo FAILED", { status: r.status, response: r.data });
    throw new Error(`video info gagal`);
  }
  sendLog(res, "success", "Video info OK");
  return r.data.data;
}

async function startTranscode(client, gnum, fileKey, res) {
  sendLog(res, "info", "Starting transcode...");
  const body = baseParams(gnum, { file_key: fileKey });
  const r = await client.post("/api/file/video_trans_start.json", body.toString(), {
    headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  if (r.status >= 400 || r.data?.code !== 0 || !r.data?.data?.id) {
    sendLog(res, "error", "startTranscode FAILED", { status: r.status, response: r.data });
    throw new Error(`transcode start gagal`);
  }
  sendLog(res, "success", `Transcode started, id=${r.data.data.id}`);
  return r.data.data.id;
}

async function queryTranscode(client, gnum, id) {
  const params = baseParams(gnum, { id });
  const r = await client.get(`/api/file/video_trans_query.json?${params}`, { headers: traceHeaders() });
  if (r.status >= 400 || r.data?.code !== 0) throw new Error(`transcode query gagal`);
  return r.data.data;
}

async function waitTranscode(client, gnum, id, fallback, res) {
  sendLog(res, "info", "Waiting for transcode (polling every 3s)...");
  for (let i = 0; i < 60; i++) {
    const data = await queryTranscode(client, gnum, id);
    const video = data?.video || data?.url || data?.source_url || "";
    const transcoded = data?.video_transcoded || data?.transcoded_video || data?.transcoded_url || data?.video_url || "";
    sendEvent(res, "progress", { step: "transcode", attempt: i + 1 });
    sendLog(res, "debug", `Transcode poll #${i+1}`, { has_transcoded: !!transcoded });
    if (transcoded) { sendLog(res, "success", "Transcode completed"); return { source_url: video || fallback, video_transcoded: transcoded }; }
    await sleep(3000);
  }
  sendLog(res, "warn", "Transcode timeout, using fallback");
  return { source_url: fallback, video_transcoded: fallback };
}

async function delivery(client, gnum, sourceUrl, videoTranscoded, taskName, res) {
  sendLog(res, "info", `Submitting enhancement task: ${taskName}`);
  const body = baseParams(gnum, {
    type: TASK_TYPE, content_type: CONTENT_TYPE, source_url: sourceUrl,
    type_params: JSON.stringify({ is_mirror: 0, orientation_tag: 1, j_420_trans: "1", return_ext: "2" }),
    right_detail: JSON.stringify({ source: "1", touch_type: "4", function_id: "630", material_id: "63011", url: "https://wink.ai/video-enhancer/upload" }),
    ext_params: JSON.stringify({ task_name: taskName, records: TASK_TYPE, video_transcoded: videoTranscoded }),
    with_prepare: "1",
  });
  const r = await client.post("/api/meitu_ai/delivery.json", body.toString(), {
    headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  if (r.status >= 400 || r.data?.code !== 0) {
    sendLog(res, "error", "delivery FAILED", { status: r.status, response: r.data });
    throw new Error(`delivery gagal`);
  }
  const data = r.data.data || {};
  sendLog(res, "success", "Task submitted", { msg_id: data.msg_id, prepare_msg_id: data.prepare_msg_id });
  return data;
}

async function queryBatch(client, gnum, msgId) {
  const params = baseParams(gnum, { msg_ids: msgId });
  const r = await client.get(`/api/meitu_ai/query_batch.json?${params}`, {
    headers: { ...traceHeaders(), referer: `${BASE_URL}/video-enhancer/upload` },
  });
  if (r.status >= 400 || r.data?.code !== 0) throw new Error(`query batch gagal`);
  return r.data.data;
}

function extractResultUrl(data) {
  const item = data?.item_list?.[0];
  const media = item?.result?.media_info_list?.[0];
  return media?.media_data || item?.result?.result_url || item?.result?.url || item?.client_ext_params?.video_transcoded || "";
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
  sendLog(res, "info", `Waiting for enhancement result (msg_id: ${firstMsgId})...`);
  let msgId = firstMsgId;
  for (let i = 0; i < 120; i++) {
    const data = await queryBatch(client, gnum, msgId);
    const next = extractNextMsgId(data, msgId);
    if (next) { sendLog(res, "debug", `Redirect to new msg_id: ${next}`); msgId = next; await sleep(1000); continue; }
    const url = extractResultUrl(data);
    const errCode = data?.item_list?.[0]?.result?.error_code;
    const errMsg = data?.item_list?.[0]?.result?.error_msg;
    sendEvent(res, "progress", { step: "enhance", attempt: i + 1 });
    sendLog(res, "debug", `Enhance poll #${i+1}`, { error_code: errCode, has_url: !!url });
    if (url && url.startsWith("http") && errCode === 0) { sendLog(res, "success", "Enhancement DONE!"); return url; }
    if (errCode && errCode !== 29901 && errCode !== 0) { sendLog(res, "error", `Task failed: code=${errCode} msg=${errMsg || "-"}`); throw new Error(`task gagal: ${errCode} ${errMsg || ""}`); }
    await sleep(5000);
  }
  sendLog(res, "error", "Timeout waiting for result");
  throw new Error("result timeout");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }

  const { videoUrl, filename } = parsed;
  if (!videoUrl) return res.status(400).json({ error: "videoUrl diperlukan" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let tmpPath = null;
  try {
    const safeName = filename || `video-${Date.now()}.mp4`;
    const taskName = `Enhancer-Ultra HD-${path.parse(safeName).name}`;

    sendLog(res, "info", `=== NEW REQUEST: ${safeName} ===`);
    sendEvent(res, "progress", { step: "download", message: "Downloading video from temp storage...", pct: 0 });

    tmpPath = await downloadToTmp(videoUrl, res);

    sendEvent(res, "progress", { step: "init", message: "Starting session..." });
    const gnum = crypto.randomUUID();
    sendLog(res, "debug", `Session gnum: ${gnum}`);
    const jar = new CookieJar();
    await jar.setCookie(`_sm=${gnum}; Path=/; Domain=wink.ai`, BASE_URL);
    await jar.setCookie(`meitustat=${encodeURIComponent(JSON.stringify({ wgid: gnum }))}; Path=/; Domain=wink.ai`, BASE_URL);
    const client = createApiClient(gnum, jar);

    sendEvent(res, "progress", { step: "sign", message: "Getting upload token..." });
    const sign = await getMaatSign(client, gnum, res);

    sendEvent(res, "progress", { step: "policy", message: "Getting upload policy..." });
    const policy = await getUploadPolicy(sign, res);

    sendEvent(res, "progress", { step: "upload", message: "Uploading to Qiniu CDN...", pct: 0 });
    const uploaded = await uploadToQiniu(policy, tmpPath, safeName, res);

    sendEvent(res, "progress", { step: "info", message: "Processing video metadata..." });
    await getVideoInfo(client, gnum, uploaded.file_key, res);

    sendEvent(res, "progress", { step: "transcode_start", message: "Starting transcode..." });
    const transcodeId = await startTranscode(client, gnum, uploaded.file_key, res);
    const transcode = await waitTranscode(client, gnum, transcodeId, uploaded.source_url, res);

    sendEvent(res, "progress", { step: "delivery", message: "Submitting to AI Enhancer..." });
    const task = await delivery(client, gnum, transcode.source_url, transcode.video_transcoded, taskName, res);
    const firstMsgId = task.msg_id || task.prepare_msg_id;
    if (!firstMsgId) throw new Error("delivery gagal: tidak ada msg_id");

    sendEvent(res, "progress", { step: "enhance", message: "AI is processing your video..." });
    const resultUrl = await waitResult(client, gnum, firstMsgId, res);

    sendLog(res, "success", "=== REQUEST COMPLETED SUCCESSFULLY ===");
    sendEvent(res, "result", { success: true, resultUrl, filename: safeName });
    res.end();
  } catch (err) {
    console.error("Enhance error:", err);
    sendLog(res, "fatal", `REQUEST FAILED: ${err.message}`, { stack: err.stack });
    sendEvent(res, "error", { message: err.message || "Internal error" });
    res.end();
  } finally {
    if (tmpPath) { try { await fsp.unlink(tmpPath); } catch {} }
  }
}

export const config = { api: { bodyParser: false } };
