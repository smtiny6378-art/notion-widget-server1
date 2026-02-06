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
  return Array.from(new Set((arr || []).map(x => String(x || "").trim()).filter(Boolean)));
}
function safeJsonParse(s){
  try { return JSON.parse(s); } catch { return null; }
}
function pickMeta($, key) {
  return ($(`meta[property='${key}']`).attr("content") || "").trim();
}
function detectAdultFromText(text){
  const t = String(text || "").toLowerCase();
  return t.includes("19세") || t.includes("청소년 이용불가") || t.includes("성인");
}
function deepCollect(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  out.push(obj);
  for (const k of Object.keys(obj)) deepCollect(obj[k], out);
  return out;
}
function findFirstString(objects, keys){
  const keySet = new Set(keys.map(k => k.toLowerCase()));
  for (const o of objects) {
    if (!o || typeof o !== "object") continue;
    for (const k of Object.keys(o)) {
      if (!keySet.has(k.toLowerCase())) continue;
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}
function findFirstBool(objects, keys){
  const keySet = new Set(keys.map(k => k.toLowerCase()));
  for (const o of objects) {
    if (!o || typeof o !== "object") continue;
    for (const k of Object.keys(o)) {
      if (!keySet.has(k.toLowerCase())) continue;
      const v = o[k];
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true" || s === "1") return true;
        if (s === "false" || s === "0") return false;
      }
    }
  }
  return null;
}
function findStringArray(objects, keys){
  const keySet = new Set(keys.map(k => k.toLowerCase()));
  for (const o of objects) {
    if (!o || typeof o !== "object") continue;
    for (const k of Object.keys(o)) {
      if (!keySet.has(k.toLowerCase())) continue;
      const v = o[k];
      if (Array.isArray(v)) {
        const arr = v.map(x => (typeof x === "string" ? x : x?.name)).filter(Boolean);
        if (arr.length) return uniq(arr);
      }
    }
  }
  return [];
}

function cleanPublisher(p){
  const s = String(p || "").trim();
  if (!s) return "";
  if (s.includes("AI 매칭")) return "";
  if (s.includes("<")) return "";
  return s;
}

function cleanGenreArr(arr){
  const bad = new Set(["를", "을", "이", "가", "은", "는", "의", "에", "에서", "와", "과"]);
  return (arr || []).map(x => String(x || "").trim()).filter(Boolean).filter(x => !bad.has(x));
}

function buildAuthorLine({ baseAuthor, originalAuthors, adapters, artists }){
  const parts = [];
  if (baseAuthor) parts.push(baseAuthor);

  const o = uniq(originalAuthors);
  const a = uniq(adapters);
  const g = uniq(artists);

  // ✅ 제작진을 작가명에 포함
  if (o.length) parts.push(`원작: ${o.join(", ")}`);
  if (a.length) parts.push(`각색: ${a.join(", ")}`);
  if (g.length) parts.push(`그림: ${g.join(", ")}`);

  return parts.join(" · ").trim();
}

async function fetchHtml(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://webtoon.kakao.com/",
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  return await r.text();
}

module.exports = async function handler(req, res) {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const ogTitle = pickMeta($, "og:title");
    const ogDesc = pickMeta($, "og:description");
    const ogImage = absolutize(pickMeta($, "og:image"));

    let title = stripWebtoonSuffix(ogTitle) || stripWebtoonSuffix($("title").text()) || "";
    let desc = normalizeNotionText(ogDesc);

    const nextDataText = $("#__NEXT_DATA__").text() || "";
    const nextData = safeJsonParse(nextDataText);

    let apollo = null;
    const scripts = $("script").toArray().map(s => $(s).text()).join("\n");
    const apolloMatch = scripts.match(/__APOLLO_STATE__\s*=\s*({.*?})\s*;\s*\n/s);
    if (apolloMatch && apolloMatch[1]) apollo = safeJsonParse(apolloMatch[1]);

    const pool = deepCollect(nextData, []);
    deepCollect(apollo, pool);

    const t2 = findFirstString(pool, ["title", "seoTitle", "contentTitle", "name"]);
    if (!title && t2) title = stripWebtoonSuffix(t2);

    const d2 = findFirstString(pool, ["synopsis", "description", "desc", "summary", "introduce", "introduction"]);
    if (d2) desc = normalizeNotionText(d2);

    const baseAuthor =
      findFirstString(pool, ["authorName", "author", "writer", "creator", "creators"]) || "";

    const originalAuthors =
      findStringArray(pool, ["originalAuthor", "originalAuthors", "original", "originalCreators"]);

    const adapters =
      findStringArray(pool, ["adapter", "adapters", "adaptation", "adaptations", "scenario", "scenarios"]);

    const artists =
      findStringArray(pool, ["artist", "artists", "drawer", "drawers", "illustrator", "illustrators"]);

    const authorName = buildAuthorLine({ baseAuthor, originalAuthors, adapters, artists });

    const publisherName = cleanPublisher(findFirstString(pool, ["publisherName", "publisher", "providerName", "label", "imprint"]));

    let genre = findStringArray(pool, ["genre", "genres", "category", "categories"]);
    genre = cleanGenreArr(genre);

    const b1 = findFirstBool(pool, ["isAdult", "adult", "is19", "isAdultOnly", "adultOnly"]);
    let isAdult = b1 === null ? false : b1;
    if (!isAdult) isAdult = detectAdultFromText(html) || detectAdultFromText($("body").text());

    let coverUrl = ogImage;
    const img2 = findFirstString(pool, ["coverImage", "coverUrl", "thumbnailUrl", "thumbnail", "image", "imageUrl", "poster"]);
    if (!coverUrl && img2) coverUrl = absolutize(img2);

    title = stripWebtoonSuffix(title).trim();

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      title,
      coverUrl,
      authorName,
      publisherName, // AI 매칭 같은 값이면 "" 로 내려감
      genre,
      desc,
      isAdult,
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
