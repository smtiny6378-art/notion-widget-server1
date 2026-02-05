// /api/getKakaoDetail.js
import cheerio from "cheerio";

function absolutize(u) {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  if (u.startsWith("//")) return "https:" + u;
  return "https://webtoon.kakao.com" + u;
}

export default async function handler(req, res) {
  const { contentId } = req.query;
  if (!contentId) return res.status(400).json({ ok: false, error: "contentId required" });

  const url = `https://webtoon.kakao.com/content/${contentId}`;
  const html = await fetch(url).then(r => r.text());
  const $ = cheerio.load(html);

  const title = $("h3").first().text().trim();
  const author = $("span.txt_author").text().trim();
  const desc = $("p.desc_story").text().trim();

  const cover = absolutize($("img").first().attr("src"));

  const isAdult = html.includes("19세") || html.includes("성인");

  res.json({
    ok: true,
    platform: "카카오웹툰",
    contentId,
    title,
    author,
    desc,
    cover,
    isAdult,
    url
  });
}
