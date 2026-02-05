// /api/searchKakao.js
import cheerio from "cheerio";

export default async function handler(req, res) {
  const q = req.query.q;
  if (!q) return res.status(400).json({ ok: false, error: "q required" });

  const url = `https://search.kakao.com/search?w=web&q=${encodeURIComponent(q + " 카카오웹툰")}`;

  const html = await fetch(url).then(r => r.text());
  const $ = cheerio.load(html);

  const items = [];

  $("a.link_tit").each((i, el) => {
    const title = $(el).text().trim();
    const link = $(el).attr("href");

    if (!link || !link.includes("webtoon.kakao.com")) return;

    const idMatch = link.match(/content\/(\d+)/);
    const contentId = idMatch?.[1];

    items.push({
      title,
      link,
      contentId
    });
  });

  res.json({ ok: true, q, items: items.slice(0, 5) });
}
