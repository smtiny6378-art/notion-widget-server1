// /api/getKakaoDetail.js  (카카오웹툰)
const cheerio = require("cheerio");

function normalizeNotionText(v) {
  if (v == null) return "";
  return String(v).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripWebtoonSuffix(rawTitle) {
  let t = String(rawTitle || "").trim();
  t = t.replace(/\s*\|\s*카카오웹툰\s*$/i, "").trim();
  return t;
}

function absolutize(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (!s) return "";
  if (s.startsWith("http")) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return "https://webtoon.kakao.com" + s;
  return s;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean)));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function pickMeta($, key) {
  return ($(`meta[property='${key}']`).attr("content") || "").trim();
}

function collectNamesFromPage($) {
  // 웹 페이지 UI를 해외 스크롤해서 이름들을 순차적으로 긁음
  const texts = [];
  $("body *").each((i, el) => {
    const t = ($(el).text() || "").trim();
    if (t && t.length < 40 && /^[가-힣A-Za-z·,\s]+$/.test(t)) {
      texts.push(t);
    }
  });
  return texts.join("\n");
}

module.exports = async function handler(req, res) {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    // fetch html
    const r = await fetch(url, { redirect: "follow" });
    const html = await r.text();
    const $ = cheerio.load(html);

    // 기본 OG
    const ogTitle = pickMeta($, "og:title");
    const ogDesc  = pickMeta($, "og:description");
    const ogImage = absolutize(pickMeta($, "og:image"));

    let title = stripWebtoonSuffix(ogTitle) || stripWebtoonSuffix($("title").text()) || "";
    let desc  = normalizeNotionText(ogDesc);
    let coverUrl = ogImage;

    // 페이지에 있는 이름 텍스트를 가능한 한 모아서
    const allText = collectNamesFromPage($).split("\n");
    const nameCandidates = uniq(allText.filter(l => l.length > 1));

    // authorName을 가능한 값으로 설정
    const authorName = nameCandidates.join(", ");

    title = stripWebtoonSuffix(title).trim();

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "KAKAO",
      title,
      coverUrl,
      authorName,
      publisherName: "",
      genre: [], // 필요한 경우 genre 서버/프론트에서 처리
      desc,
      isAdult: false, // 웹툰엔 따로 처리 가능
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
