// /api/searchKakao.js
const cheerio = require("cheerio");

module.exports = async function handler(req, res) {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q required" });

    const url = `https://search.kakao.com/search?w=web&q=${encodeURIComponent(q + " 카카오웹툰")}`;

    const r = await fetch(url, {
      headers: {
        // 일부 환경에서 봇 차단 완화용
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
    });

    const html = await r.text();
    const $ = cheerio.load(html);

    const items = [];
    // 카카오 검색 결과 DOM이 바뀔 수 있어서, link_tit + webtoon.kakao.com만 필터링
    $("a").each((i, el) => {
      const href = $(el).attr("href") || "";
      if (!href.includes("webtoon.kakao.com")) return;

      const title = $(el).text().trim();
      const idMatch = href.match(/content\/(\d+)/);
      const contentId = idMatch?.[1];

      if (!contentId) return;

      items.push({
        title: title || "제목(추출 실패)",
        link: href,
        contentId,
      });
    });

    // 중복 제거(contentId 기준)
    const seen = new Set();
    const uniq = [];
    for (const it of items) {
      if (seen.has(it.contentId)) continue;
      seen.add(it.contentId);
      uniq.push(it);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, q, items: uniq.slice(0, 10) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
