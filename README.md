# ✨ Wink Video Enhancer

Website sederhana untuk enhance video ke Ultra HD menggunakan Wink AI, di-deploy di Vercel.

## 🚀 Cara Deploy

1. **Clone / Download** repo ini
2. Buka [vercel.com/new](https://vercel.com/new)
3. Import project dari GitHub / upload folder
4. Klik **Deploy** ✅

## 📋 Struktur

- `api/enhance.js` → Serverless function (backend)
- `public/index.html` → Frontend UI
- `vercel.json` → Konfigurasi Vercel

## ⚙️ Catatan

- **Max file size:** 200MB
- **Vercel Hobby** timeout 60 detik (mungkin tidak cukup untuk video besar)
- **Vercel Pro** mendukung hingga 300 detik — recommended untuk video panjang
- Untuk video > 2 menit, sebaiknya upgrade ke Pro

## 🔧 API

**POST** `/api/enhance`

Body: `multipart/form-data` dengan field `video`.

Response: **Server-Sent Events (SSE)** dengan event:
- `progress` → `{ step, message, pct? }`
- `result` → `{ success, resultUrl, filename }`
- `error` → `{ message }`

## 🛠️ Development Lokal

```bash
npm install
vercel dev
