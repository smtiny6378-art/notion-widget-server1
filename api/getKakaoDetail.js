// /api/getKakaoDetail.js  (카카오웹툰)
const cheerio = require("cheerio");

function normalizeNotionText(v) {
  if (v == null) return "";
  return String(v)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

/**
 * __NEXT_DATA__ / window.__APOLLO_STATE__ 등에서 정보를 최대한 건져오기
 * - 구조가 바뀌어도 "키 이름"을 재귀 탐색해서 뽑아오는 방식
 */
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

    // 1) meta 기반 기본값
    const ogTitle = pickMeta($, "og:title");
    const ogDesc = pickMeta($, "og:description");
    const ogImage = absolutize(pickMeta($, "og:image"));

    let title = stripWebtoonSuffix(ogTitle) || stripWebtoonSuffix($("title").text()) || "";
    let desc = normalizeNotionText(ogDesc);

    // 2) 구조 데이터/앱 상태에서 최대한 추출
    const nextDataText = $("#__NEXT_DATA__").text() || "";
    const nextData = safeJsonParse(nextDataText);

    // 일부 페이지는 apollo state가 script에 있을 수도 있음 (그냥 text에서 찾기)
    let apollo = null;
    const scripts = $("script").toArray().map(s => $(s).text()).join("\n");
    const apolloMatch = scripts.match(/__APOLLO_STATE__\s*=\s*({.*?})\s*;\s*\n/s);
    if (apolloMatch && apolloMatch[1]) apollo = safeJsonParse(apolloMatch[1]);

    const pool = deepCollect(nextData, []);
    deepCollect(apollo, pool);

    // title 후보
    const t2 = findFirstString(pool, ["title", "seoTitle", "contentTitle", "name"]);
    if (!title && t2) title = stripWebtoonSuffix(t2);

    // desc 후보 (줄바꿈이 포함된 synopsis/description 우선)
    const d2 = findFirstString(pool, ["synopsis", "description", "desc", "summary", "introduce", "introduction"]);
    if (d2) desc = normalizeNotionText(d2);

    // author / publisher 후보
    const author =
      findFirstString(pool, ["authorName", "author", "writer", "writers", "artist", "artists", "creator", "creators"]) ||
      "";
    // publisher는 웹툰에 없을 때가 많아서, 있으면만
    const publisher =
      findFirstString(pool, ["publisherName", "publisher", "providerName", "label", "imprint"]) ||
      "";

    // genre 후보
    let genre = findStringArray(pool, ["genre", "genres", "category", "categories"]);
    if (!genre.length) {
      // meta에서라도 유추(없어도 OK)
      const text = normalizeNotionText($("body").text());
      const m = text.match(/장르\s*[:：]?\s*([가-힣A-Za-z·\s]{2,30})/);
      if (m && m[1]) genre = uniq(m[1].split(/\s+/).filter(Boolean)).slice(0, 3);
    }

    // adult 감지
    const b1 = findFirstBool(pool, ["isAdult", "adult", "is19", "isAdultOnly", "adultOnly"]);
    let isAdult = b1 === null ? false : b1;
    if (!isAdult) isAdult = detectAdultFromText(html) || detectAdultFromText($("body").text());

    // coverUrl 후보
    let coverUrl = ogImage;
    const img2 = findFirstString(pool, ["coverImage", "coverUrl", "thumbnailUrl", "thumbnail", "image", "imageUrl", "poster"]);
    if (!coverUrl && img2) coverUrl = absolutize(img2);

    // 최종 보정
    title = stripWebtoonSuffix(title).trim();

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      title,
      coverUrl,
      authorName: author,
      publisherName: publisher,
      genre,
      desc,
      isAdult,
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
