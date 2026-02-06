// api/parseKakao.js
module.exports = async function handler(req, res) {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    // 카카오웹툰
    if (url.includes("webtoon.kakao.com")) {
      const webtoon = require("./getKakaoDetail"); // ✅ 카카오웹툰 파서(우리가 쓰는 파일)
      return webtoon(req, res);
    }

    // 카카오페이지
    if (url.includes("page.kakao.com")) {
      // ✅ getKakaoPageDetail 같은 파일은 더 이상 쓰지 않음
      // ✅ 카카오페이지는 searchKakao.js로 고정
      const page = require("./searchKakao");
      return page(req, res);
    }

    return res.status(400).json({ ok: false, error: "지원하지 않는 도메인" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
