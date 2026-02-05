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
      // ✅ 새 파일 추가 없이, 기존 함수 파일로 연결
      const page = require("./searchKakao"); // <- 여기 중요!
      return page(req, res);
    }

    return res.status(400).json({ ok: false, error: "지원하지 않는 도메인" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
