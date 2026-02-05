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
    const url = (req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
    });

    const html = await r.text();
    const $ = cheerio.load(html);

    const title =
      $("meta[property='og:title']").attr("content")?.trim() ||
      $("h1,h2,h3").first().text().trim() ||
      "";

    const desc =
      $("meta[property='og:description']").attr("content")?.trim() ||
      "";

    const cover = absolutize(
      $("meta[property='og:image']").attr("content")?.trim() || ""
    );

    const isAdult = html.includes("19세") || html.includes("성인");

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      title,
      author: "",
      desc,
      cover,
      isAdult,
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
