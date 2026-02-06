// /api/parseKakao.js
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    if (url.includes("webtoon.kakao.com")) {
      const webtoon = require("./getKakaoDetail"); // ✅ 위에서 준 카카오웹툰 파서
      return webtoon(req, res);
    }

    if (url.includes("page.kakao.com")) {
      const page = require("./getKakaoPageDetail"); // ✅ 너가 준 카카오페이지 상세 파서
      return page(req, res);
    }

    return res.status(400).json({ ok: false, error: "지원하지 않는 도메인" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
