// /api/kakaopage-search.js
const cheerio = require("cheerio");

function normalizeSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean)));
}
function stripTitleSuffix(rawTitle) {
  let t = String(rawTitle || "").trim();
  t = t.replace(/\s*\|\s*카카오페이지\s*$/i, "").trim();
  t = t.replace(/\s*-\s*웹툰\s*$/i, "").trim();
  t = t.replace(/\s*-\s*웹소설\s*$/i, "").trim();
  t = t.replace(/\s*-\s*책\s*$/i, "").trim();
  return t;
}
function absolutize(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (!s) return "";
  if (s.startsWith("http")) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return "https://page.kakao.com" + s;
  return s;
}
function pickMeta($, propOrName) {
  if (propOrName?.prop) return ($(`meta[property='${propOrName.prop}']`).attr("content") || "").trim();
  if (propOrName?.name) return ($(`meta[name='${propOrName.name}']`).attr("content") || "").trim();
  return "";
}
function detectAdult(html, $) {
  const text = `${html}\n${$("body").text()}`.toLowerCase();
  return text.includes("19세") || text.includes("성인") || text.includes("청소년 이용불가");
}
function findFirstViewerUrl(html, $) {
  const a = $("a[href*='/viewer/']").first().attr("href");
  if (a) {
    const href = String(a).trim();
    if (href.startsWith("http")) return href;
    if (href.startsWith("/")) return "https://page.kakao.com" + href;
  }
  const m = String(html || "").match(/https:\/\/page\.kakao\.com\/content\/\d+\/viewer\/\d+/);
  if (m) return m[0];
  const m2 = String(html || "").match(/\/content\/\d+\/viewer\/\d+/);
  if (m2) return "https://page.kakao.com" + m2[0];
  return "";
}
function extractAuthorFromTitleLine(pageText, title) {
  const t = normalizeSpace(title);
  if (!t) return "";

  const lines = String(pageText || "")
    .split("\n")
    .map((l) => normalizeSpace(l))
    .filter(Boolean);

  const candidates = lines.filter((l) => l.includes(t)).sort((a, b) => a.length - b.length);
  if (!candidates.length) return "";

  const line = candidates[0];
  const idx = line.indexOf(t);
  const after = normalizeSpace(line.slice(idx + t.length));

  if (!after) return "";
  if (after.includes("웹툰") || after.includes("웹소설") || after.includes("연재")) return "";

  const cut = after.split("  ")[0].trim();
  return cut.slice(0, 80);
}
function extractGenreFromText(pageText) {
  const text = normalizeSpace(pageText);
  if (!text) return [];
  const genres = [];
  const m = text.match(/웹툰\s*([가-힣A-Za-z·\s]{2,30})/);
  if (m && m[1]) {
    const g = normalizeSpace(m[1])
      .split(" ")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => x !== "리스트" && x !== "구분자" && x !== "연재");
    genres.push(...g.slice(0, 3));
  }
  return uniq(genres);
}
function cleanGenre(arr) {
  const bad = new Set(["를", "을", "이", "가", "은", "는", "의", "에", "에서", "와", "과"]);
  return (arr || []).map((x) => String(x || "").trim()).filter(Boolean).filter((x) => !bad.has(x));
}

async function fetchHtml(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://page.kakao.com/",
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  return await r.text();
}

// ✅ page.kakao.com/content/64257452 형태를 최대한 그대로 지원
module.exports = async function handler(req, res) {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const ogTitle = pickMeta($, { prop: "og:title" });
    const ogDesc = pickMeta($, { prop: "og:description" }) || pickMeta($, { name: "description" });
    const ogImage = pickMeta($, { prop: "og:image" });

    const title = stripTitleSuffix(ogTitle) || stripTitleSuffix($("title").text()) || "";
    const coverUrl = absolutize(ogImage);
    let desc = (ogDesc || "").trim();
    let isAdult = detectAdult(html, $);

    const pageText = $("body").text() || "";
    let authorName = extractAuthorFromTitleLine(pageText, title);
    let genre = cleanGenre(extractGenreFromText(pageText));

    const viewerUrl = findFirstViewerUrl(html, $);
    let usedViewer = "";

    if (viewerUrl) {
      try {
        const vhtml = await fetchHtml(viewerUrl);
        const $v = cheerio.load(vhtml);

        const vDesc = pickMeta($v, { prop: "og:description" }) || pickMeta($v, { name: "description" });
        const vTitle = stripTitleSuffix(pickMeta($v, { prop: "og:title" })) || "";

        if (vDesc && vDesc.length > desc.length) desc = vDesc.trim();
        isAdult = detectAdult(vhtml, $v) || isAdult;

        const vText = $v("body").text() || "";
        if (!authorName) authorName = extractAuthorFromTitleLine(vText, title) || extractAuthorFromTitleLine(vText, vTitle);
        if (!genre.length) genre = cleanGenre(extractGenreFromText(vText));

        usedViewer = viewerUrl;
      } catch {}
    }

    genre = cleanGenre(genre);

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오페이지",
      title,
      coverUrl,
      authorName,
      genre,
      desc,
      isAdult,
      url,
      ...(req.query.debug ? { usedViewer } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
