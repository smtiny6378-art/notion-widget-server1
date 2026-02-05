// api/parseKakao.js
module.exports = async function handler(req, res) {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    if (url.includes("webtoon.kakao.com")) {
      const webtoon = require("./getKakaoDetail");
      return webtoon(req, res);
    }

    if (url.includes("page.kakao.com")) {
      const page = require("./getKakaoPageDetail"); // ← 이제 파일 생기면 에러 사라짐
      return page(req, res);
    }

    return res.status(400).json({ ok: false, error: "지원하지 않는 도메인" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
