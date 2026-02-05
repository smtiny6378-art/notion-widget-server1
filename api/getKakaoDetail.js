// /api/getKakaoDetail.js
const cheerio = require("cheerio");

function absolutize(u) {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  if (u.startsWith("//")) return "https:" + u;
  return "https://webtoon.kakao.com" + u;
}

module.exports = async function handler(req, res) {
  try {
    const contentId = (req.query.contentId || "").trim();
    if (!contentId) return res.status(400).json({ ok: false, error: "contentId required" });

    const url = `https://webtoon.kakao.com/content/${contentId}`;

    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
    });

    const html = await r.text();
    const $ = cheerio.load(html);

    // 최대한 안전하게 추출 (사이트 구조가 바뀔 수 있어서 여러 후보를 둠)
    const title =
      $("meta[property='og:title']").attr("content")?.trim() ||
      $("h3").first().text().trim() ||
      "";

    const desc =
      $("meta[property='og:description']").attr("content")?.trim() ||
      $("p").text().trim().slice(0, 300) ||
      "";

    const cover =
      absolutize($("meta[property='og:image']").attr("content")?.trim() || $("img").first().attr("src"));

    const isAdult = html.includes("19세") || html.includes("성인");

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      contentId,
      title,
      author: "", // 카카오웹툰은 author DOM이 자주 바뀌어서 일단 빈값 (원하면 다음에 안정적으로 뽑아줄게)
      desc,
      cover,
      isAdult,
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
