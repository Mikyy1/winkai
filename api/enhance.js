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
const safeStr = (o) => { try { return typeof o === "string" ? o : JSON.stringify(o); } catch { return String(o); } };

function makeTrace() { return crypto.randomBytes(16).toString("hex") + "-" + crypto.randomBytes(8).toString("hex") + "-1"; }
function traceHeaders() {
  const t = makeTrace();
  return { "sentry-trace": t, baggage: "sentry-environment=release,sentry-release=5.1.2,sentry-public_key=e1bf914f3448d9bc8a10c7e499d17d54,sentry-trace_id=" + t.split("-")[0] + ",sentry-sampled=true,sentry-sample_rate=0.75" };
}
function extToMime(f) { const e = path.extname(f).toLowerCase(); return {".mp4":"video/mp4",".mov":"video/quicktime",".webm":"video/webm",".mkv":"video/x-matroska"}[e]||"application/octet-stream"; }
function baseParams(g, x={}) { return new URLSearchParams({client_id:CLIENT_ID,version:VERSION,country_code:COUNTRY_CODE,gnum:g,client_language:CLIENT_LANGUAGE,client_channel_id:"",client_timezone:CLIENT_TIMEZONE,...x}); }

function mkClient(g, jar) {
  return wrapper(axios.create({baseURL:BASE_URL,jar,withCredentials:true,validateStatus:()=>true,headers:{accept:"*/*",origin:BASE_URL,referer:BASE_URL+"/video-enhancer/upload","user-agent":UA,"sec-ch-ua":'"Chromium";v="147"',"sec-ch-ua-mobile":"?1","sec-ch-ua-platform":'"Android"',ab_info:JSON.stringify({ab_codes:[],version:"1.4.4"})}}));
}

function sendEvt(r,e,d){try{r.write("event: "+e+"\ndata: "+JSON.stringify(d)+"\n\n");}catch{}}
function sendLog(r,lv,msg,det=null){
  const ts=new Date().toISOString().slice(11,23);
  sendEvt(r,"log",{level:lv,message:msg,detail:det?safeStr(det):null,ts});
  console.log("["+ts+"] ["+lv+"] "+msg,det?safeStr(det).slice(0,500):"");
}

// ============ GUEST USER REGISTRATION ============
async function registerGuest(res) {
  sendLog(res, "info", "Registering guest user...");

  // Generate device fingerprint
  const deviceId = crypto.randomUUID().replace(/-/g, "");
  const gnum = crypto.randomUUID();

  // Try multiple registration endpoints
  const endpoints = [
    {
      url: "/api/user/device_register.json",
      method: "POST",
      body: new URLSearchParams({
        client_id: CLIENT_ID, version: VERSION, country_code: COUNTRY_CODE,
        gnum, client_language: CLIENT_LANGUAGE, client_timezone: CLIENT_TIMEZONE,
        device_id: deviceId, platform: "web", device_type: "mobile",
        os: "Android", os_version: "10", browser: "Chrome",
      }).toString(),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    },
    {
      url: "/api/user/guest_register.json",
      method: "POST",
      body: new URLSearchParams({
        client_id: CLIENT_ID, version: VERSION, country_code: COUNTRY_CODE,
        gnum, client_language: CLIENT_LANGUAGE, client_timezone: CLIENT_TIMEZONE,
        device_id: deviceId,
      }).toString(),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    },
    {
      url: "/api/user/third_party_login.json",
      method: "POST",
      body: new URLSearchParams({
        client_id: CLIENT_ID, version: VERSION, country_code: COUNTRY_CODE,
        gnum, client_language: CLIENT_LANGUAGE, client_timezone: CLIENT_TIMEZONE,
        type: "guest", device_id: deviceId,
      }).toString(),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    },
  ];

  for (const ep of endpoints) {
    try {
      sendLog(res, "debug", "Trying register endpoint: " + ep.url);
      const r = await axios.post(BASE_URL + ep.url, ep.body, {
        headers: {
          "content-type": ep.contentType,
          origin: BASE_URL,
          referer: BASE_URL + "/",
          "user-agent": UA,
          accept: "*/*",
        },
        validateStatus: () => true,
      });

      sendLog(res, "debug", "Register response (" + r.status + "):", r.data);

      if (r.status === 200 && r.data?.code === 0) {
        sendLog(res, "success", "Guest registration OK via " + ep.url, r.data.data);
        return { gnum, deviceId, userData: r.data.data };
      }
    } catch (err) {
      sendLog(res, "debug", "Register endpoint " + ep.url + " failed: " + err.message);
    }
  }

  // Fallback: just use gnum as identifier
  sendLog(res, "warn", "No register endpoint worked, using gnum as fallback");
  return { gnum, deviceId, userData: null };
}

// ============ DOWNLOAD VIDEO ============
async function downloadVideo(url, res) {
  sendLog(res, "info", "Downloading video from: " + url.slice(0, 100));
  sendEvt(res, "progress", { step: "download", message: "Downloading your video...", pct: 0 });
  const tmpPath = path.join(os.tmpdir(), "wink-" + crypto.randomUUID() + ".mp4");
  const r = await axios.get(url, { responseType: "stream", timeout: 120000, headers: { "user-agent": UA, accept: "*/*" }, maxRedirects: 5 });
  const total = parseInt(r.headers["content-length"] || "0");
  sendLog(res, "info", "File size: " + (total / 1024 / 1024).toFixed(2) + " MB, type: " + (r.headers["content-type"] || "unknown"));
  let downloaded = 0, lastPct = -1;
  const writer = fs.createWriteStream(tmpPath);
  r.data.on("data", (chunk) => { downloaded += chunk.length; if (total) { const pct = Math.round((downloaded / total) * 100); if (pct !== lastPct && pct % 10 === 0) { sendEvt(res, "progress", { step: "download", pct }); lastPct = pct; } } });
  r.data.pipe(writer);
  await new Promise((ok, fail) => { writer.on("finish", ok); writer.on("error", fail); });
  const stat = await fsp.stat(tmpPath);
  sendLog(res, "success", "Downloaded: " + (stat.size / 1024 / 1024).toFixed(2) + " MB");
  return tmpPath;
}

// ============ WINK API FUNCTIONS ============
async function getMaatSign(c, g, res) {
  sendLog(res, "info", "Getting upload sign...");
  const p = baseParams(g, { suffix: ".mp4", type: "temp", count: "1" });
  const r = await c.get("/api/file/get_maat_sign.json?" + p, { headers: traceHeaders() });
  if (r.status >= 400 || r.data?.code !== 0) { sendLog(res, "error", "get_maat_sign FAILED", r.data); throw new Error("get_maat_sign gagal"); }
  sendLog(res, "success", "Upload sign OK");
  return r.data.data;
}

async function getPolicy(sign, res) {
  sendLog(res, "info", "Getting upload policy...");
  const p = new URLSearchParams({app:sign.app,count:String(sign.count),sig:sign.sig,sigTime:sign.sig_time,sigVersion:sign.sig_version,suffix:sign.suffix,type:sign.type});
  const r = await axios.get(STRATEGY_URL + "/upload/policy?" + p, {headers:{accept:"*/*",origin:BASE_URL,referer:BASE_URL+"/","user-agent":UA},validateStatus:()=>true});
  if (r.status >= 400 || !Array.isArray(r.data) || !r.data[0]?.qiniu) { sendLog(res, "error", "getPolicy FAILED", r.data); throw new Error("upload policy gagal"); }
  sendLog(res, "success", "Policy OK");
  return r.data[0].qiniu;
}

async function uploadQiniu(policy, filePath, filename, res) {
  sendLog(res, "info", "Uploading to Qiniu CDN...");
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), { filename, contentType: extToMime(filename) });
  form.append("token", policy.token); form.append("key", policy.key); form.append("fname", filename);
  const r = await axios.post(policy.url, form, {
    headers: form.getHeaders({origin:BASE_URL,referer:BASE_URL+"/","user-agent":UA,accept:"*/*"}),
    maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true,
    onUploadProgress: (p) => { if (p.total) sendEvt(res, "progress", { step: "upload", pct: Math.round((p.loaded / p.total) * 100) }); },
  });
  if (r.status >= 400) { sendLog(res, "error", "Qiniu FAILED", { status: r.status, data: r.data }); throw new Error("qiniu upload gagal"); }
  sendLog(res, "success", "Qiniu OK");
  return { file_key: policy.key, source_url: r.data.url || r.data.data || policy.data };
}

async function getVideoInfo(c, g, fk, res) {
  sendLog(res, "info", "Getting video info...");
  const b = baseParams(g, { file_key: fk });
  const r = await c.post("/api/file/video_cover_and_display_info_ext.json", b.toString(), {headers:{...traceHeaders(),"content-type":"application/x-www-form-urlencoded;charset=UTF-8"}});
  if (r.status >= 400 || r.data?.code !== 0) { sendLog(res, "error", "videoInfo FAILED", r.data); throw new Error("video info gagal"); }
  sendLog(res, "success", "Video info OK");
  return r.data.data;
}

async function startTranscode(c, g, fk, res) {
  sendLog(res, "info", "Starting transcode...");
  const b = baseParams(g, { file_key: fk });
  const r = await c.post("/api/file/video_trans_start.json", b.toString(), {headers:{...traceHeaders(),"content-type":"application/x-www-form-urlencoded;charset=UTF-8"}});
  if (r.status >= 400 || r.data?.code !== 0 || !r.data?.data?.id) { sendLog(res, "error", "transcode FAILED", r.data); throw new Error("transcode gagal"); }
  sendLog(res, "success", "Transcode started id=" + r.data.data.id);
  return r.data.data.id;
}

async function pollTranscode(c, g, id, fallback, res) {
  sendLog(res, "info", "Polling transcode (every 3s)...");
  for (let i = 0; i < 60; i++) {
    const p = baseParams(g, { id });
    const r = await c.get("/api/file/video_trans_query.json?" + p, { headers: traceHeaders() });
    if (r.status >= 400 || r.data?.code !== 0) { sendLog(res, "warn", "transcode poll error"); await sleep(3000); continue; }
    const d = r.data.data;
    if (i === 0 || i % 5 === 0) sendLog(res, "debug", "Transcode poll #" + (i+1) + " FULL:", d);
    const status = d?.status || d?.state || "";
    const video = d?.video || d?.url || d?.source_url || d?.video_url || "";
    const transcoded = d?.video_transcoded || d?.transcoded_video || d?.transcoded_url || d?.trans_url || d?.result_url || "";
    sendEvt(res, "progress", { step: "transcode", attempt: i + 1 });
    sendLog(res, "debug", "Transcode poll #" + (i+1) + " status=" + status + " video=" + !!video + " tc=" + !!transcoded);

    if (status === 2 || status === 3 || status === "done" || status === "complete") {
      sendLog(res, "success", "Transcode done (status=" + status + ")");
      return { source_url: video || fallback, video_transcoded: transcoded || video || fallback };
    }
    if (transcoded && typeof transcoded === "string" && transcoded.startsWith("http")) {
      sendLog(res, "success", "Transcode done - found URL");
      return { source_url: video || fallback, video_transcoded: transcoded };
    }
    await sleep(3000);
  }
  sendLog(res, "warn", "Transcode timeout");
  return { source_url: fallback, video_transcoded: fallback };
}

async function delivery(c, g, srcUrl, tcUrl, name, guestData, res) {
  sendLog(res, "info", "Submitting AI task: " + name);
  sendLog(res, "debug", "source_url=" + (srcUrl || "").slice(0, 80) + " video_transcoded=" + (tcUrl || "").slice(0, 80));

  // Build params with user info from guest registration
  const extraParams = {};
  if (guestData?.userData?.user_id || guestData?.userData?.uid) {
    extraParams.user_id = guestData.userData.user_id || guestData.userData.uid;
    sendLog(res, "debug", "Using user_id from registration: " + extraParams.user_id);
  }
  if (guestData?.userData?.token) {
    extraParams.token = guestData.userData.token;
  }
  if (guestData?.deviceId) {
    extraParams.device_id = guestData.deviceId;
  }

  const b = baseParams(g, {
    type: TASK_TYPE, content_type: CONTENT_TYPE, source_url: srcUrl,
    type_params: JSON.stringify({is_mirror:0,orientation_tag:1,j_420_trans:"1",return_ext:"2"}),
    right_detail: JSON.stringify({source:"1",touch_type:"4",function_id:"630",material_id:"63011",url:"https://wink.ai/video-enhancer/upload"}),
    ext_params: JSON.stringify({task_name:name,records:TASK_TYPE,video_transcoded:tcUrl}),
    with_prepare: "1",
    ...extraParams,
  });

  sendLog(res, "debug", "Delivery params include: " + Object.keys(extraParams).join(", ") || "none");

  const r = await c.post("/api/meitu_ai/delivery.json", b.toString(), {headers:{...traceHeaders(),"content-type":"application/x-www-form-urlencoded;charset=UTF-8"}});
  sendLog(res, "debug", "Delivery response:", r.data);

  if (r.status >= 400 || r.data?.code !== 0) {
    sendLog(res, "error", "delivery FAILED", { status: r.status, response: r.data });
    throw new Error("delivery gagal: " + (r.data?.msg || safeStr(r.data)));
  }

  const d = r.data.data || {};
  sendLog(res, "success", "Task submitted", { msg_id: d.msg_id, prepare_msg_id: d.prepare_msg_id });
  return d;
}

async function pollResult(c, g, firstId, res) {
  sendLog(res, "info", "Polling AI result (msg_id: " + firstId + ")...");
  let mid = firstId;
  for (let i = 0; i < 120; i++) {
    const p = baseParams(g, { msg_ids: mid });
    const r = await c.get("/api/meitu_ai/query_batch.json?" + p, {headers:{...traceHeaders(),referer:BASE_URL+"/video-enhancer/upload"}});
    if (r.status >= 400 || r.data?.code !== 0) { sendLog(res, "warn", "query error"); await sleep(5000); continue; }
    const d = r.data.data;
    const item = d?.item_list?.[0];
    if (i % 5 === 0 && item?.result) sendLog(res, "debug", "Enhance poll #" + (i+1) + " result:", item.result);
    const rv = item?.result?.result || "";
    const rm = item?.result?.msg_id || item?.msg_id || "";
    if (rv && rv !== mid && !rv.startsWith("http")) { mid = rv; await sleep(1000); continue; }
    if (rm && rm !== mid && !rm.startsWith("wpr_")) { mid = rm; await sleep(1000); continue; }
    const media = item?.result?.media_info_list?.[0];
    const url = media?.media_data || item?.result?.result_url || item?.result?.url || item?.client_ext_params?.video_transcoded || "";
    const ec = item?.result?.error_code;
    const em = item?.result?.error_msg;
    sendEvt(res, "progress", { step: "enhance", attempt: i + 1 });
    sendLog(res, "debug", "Enhance poll #" + (i+1) + " ec=" + ec + " has_url=" + !!url);
    if (url && url.startsWith("http") && ec === 0) { sendLog(res, "success", "DONE!"); return url; }
    if (ec && ec !== 29901 && ec !== 0) { sendLog(res, "error", "Task failed: " + ec + " " + (em||"")); throw new Error("task gagal: " + ec + " " + (em||"")); }
    await sleep(5000);
  }
  throw new Error("result timeout");
}

// ============ MAIN HANDLER ============
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = "";
  for await (const c of req) body += c;
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
    const name = filename || "video-" + Date.now() + ".mp4";
    const taskName = "Enhancer-Ultra HD-" + path.parse(name).name;
    sendLog(res, "info", "=== START: " + name + " ===");

    // Step 1: Register guest user
    sendEvt(res, "progress", { step: "init", message: "Registering guest user..." });
    const guest = await registerGuest(res);
    sendLog(res, "info", "Guest session: gnum=" + guest.gnum + " device=" + guest.deviceId);

    // Step 2: Download video
    sendEvt(res, "progress", { step: "download", message: "Downloading video..." });
    tmpPath = await downloadVideo(videoUrl, res);

    // Step 3: Setup client with guest session
    const jar = new CookieJar();
    await jar.setCookie("_sm=" + guest.gnum + "; Path=/; Domain=wink.ai", BASE_URL);
    await jar.setCookie("meitustat=" + encodeURIComponent(JSON.stringify({wgid:guest.gnum})) + "; Path=/; Domain=wink.ai", BASE_URL);
    if (guest.userData?.token) {
      await jar.setCookie("token=" + guest.userData.token + "; Path=/; Domain=wink.ai", BASE_URL);
    }
    if (guest.userData?.user_id || guest.userData?.uid) {
      const uid = guest.userData.user_id || guest.userData.uid;
      await jar.setCookie("uid=" + uid + "; Path=/; Domain=wink.ai", BASE_URL);
      sendLog(res, "debug", "Set cookie uid=" + uid);
    }
    const client = mkClient(guest.gnum, jar);

    // Step 4: Wink AI pipeline
    sendEvt(res, "progress", { step: "sign" });
    const sign = await getMaatSign(client, guest.gnum, res);

    sendEvt(res, "progress", { step: "policy" });
    const policy = await getPolicy(sign, res);

    sendEvt(res, "progress", { step: "upload", pct: 0 });
    const up = await uploadQiniu(policy, tmpPath, name, res);

    sendEvt(res, "progress", { step: "info" });
    await getVideoInfo(client, guest.gnum, up.file_key, res);

    sendEvt(res, "progress", { step: "transcode_start" });
    const tcId = await startTranscode(client, guest.gnum, up.file_key, res);
    const tc = await pollTranscode(client, guest.gnum, tcId, up.source_url, res);

    sendEvt(res, "progress", { step: "delivery" });
    const task = await delivery(client, guest.gnum, tc.source_url, tc.video_transcoded, taskName, guest, res);
    const msgId = task.msg_id || task.prepare_msg_id;
    if (!msgId) throw new Error("no msg_id");

    sendEvt(res, "progress", { step: "enhance" });
    const resultUrl = await pollResult(client, guest.gnum, msgId, res);

    sendLog(res, "success", "=== COMPLETED ===");
    sendEvt(res, "result", { success: true, resultUrl, filename: name });
    res.end();
  } catch (err) {
    console.error("Error:", err);
    sendLog(res, "fatal", "FAILED: " + err.message);
    sendEvt(res, "error", { message: err.message });
    res.end();
  } finally {
    if (tmpPath) try { await fsp.unlink(tmpPath); } catch {}
  }
}

export const config = { api: { bodyParser: false } };
