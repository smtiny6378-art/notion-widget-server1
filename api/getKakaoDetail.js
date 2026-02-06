// /api/getKakaoDetail.js  (카카오웹툰) - 안정 버전(되돌리기용)
// ✅ 목표
// - authorName이 "안 뜨는" 상황을 피하기 위해 필터를 최소화
// - 가능하면 원작/각색/그림 제작진을 authorName에 합침
// - 제목 " | 카카오웹툰" 제거
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
function detectAdultFromText(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("19세") || t.includes("청소년 이용불가") || t.includes("성인");
}
function deepCollect(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  out.push(obj);
  for (const k of Object.keys(obj)) deepCollect(obj[k], out);
  return out;
}
function findFirstString(objects, keys) {
  const keySet = new Set(keys.map((k) => k.toLowerCase()));
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
function findFirstBool(objects, keys) {
  const keySet = new Set(keys.map((k) => k.toLowerCase()));
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
function findStringArray(objects, keys) {
  const keySet = new Set(keys.map((k) => k.toLowerCase()));
  for (const o of objects) {
    if (!o || typeof o !== "object") continue;
    for (const k of Object.keys(o)) {
      if (!keySet.has(k.toLowerCase())) continue;
      const v = o[k];
      if (Array.isArray(v)) {
        const arr = v
          .map((x) => {
            if (typeof x === "string") return x;
            if (x && typeof x === "object") return x.name || x.title || x.label || "";
            return "";
          })
          .filter(Boolean);
        if (arr.length) return uniq(arr);
      }
    }
  }
  return [];
}

function joinPeople(arr) {
  return uniq(arr).join(", ");
}

// ✅ 최소 필터: "작가:" 같은 접두어/괄호만 제거하고, 나머지는 최대한 살림
function cleanBaseAuthor(s) {
  let t = String(s || "").trim();
  if (!t) return "";
  t = t.replace(/^작가\s*[:：]\s*/g, "");
  t = t.replace(/\([^)]*\)/g, " "); // (장르) 같은 괄호만 제거
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function buildAuthorLine({ baseAuthor, originalAuthors, adapters, artists }) {
  const parts = [];
  const base = cleanBaseAuthor(baseAuthor);
  if (base) parts.push(base);

  const o = uniq(originalAuthors);
  const a = uniq(adapters);
  const g = uniq(artists);

  if (o.length) parts.push(`원작: ${joinPeople(o)}`);
  if (a.length) parts.push(`각색: ${joinPeople(a)}`);
  if (g.length) parts.push(`그림: ${joinPeople(g)}`);

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

    // OG 기본
    const ogTitle = pickMeta($, "og:title");
    const ogDesc  = pickMeta($, "og:description");
    const ogImage = absolutize(pickMeta($, "og:image"));

    let title = stripWebtoonSuffix(ogTitle) || stripWebtoonSuffix($("title").text()) || "";
    let desc  = normalizeNotionText(ogDesc);
    let coverUrl = ogImage;

    // Next/Apollo 데이터 풀
    const nextDataText = $("#__NEXT_DATA__").text() || "";
    const nextData = safeJsonParse(nextDataText);

    let apollo = null;
    const scripts = $("script").toArray().map((s) => $(s).text()).join("\n");
    const apolloMatch = scripts.match(/__APOLLO_STATE__\s*=\s*({.*?})\s*;\s*\n/s);
    if (apolloMatch && apolloMatch[1]) apollo = safeJsonParse(apolloMatch[1]);

    const pool = deepCollect(nextData, []);
    deepCollect(apollo, pool);

    // 제목/소개/표지 보강
    const t2 = findFirstString(pool, ["title", "seoTitle", "contentTitle", "name"]);
    if (!title && t2) title = stripWebtoonSuffix(t2);

    const d2 = findFirstString(pool, ["synopsis", "description", "desc", "summary", "introduce", "introduction"]);
    if (d2) desc = normalizeNotionText(d2);

    const img2 = findFirstString(pool, ["coverImage", "coverUrl", "thumbnailUrl", "thumbnail", "image", "imageUrl", "poster"]);
    if (!coverUrl && img2) coverUrl = absolutize(img2);

    // ✅ 핵심: authorName은 무조건 "있는 것"을 살린다
    const baseAuthor =
      findFirstString(pool, ["authorName", "author", "writer", "creator", "creators"]) || "";

    // 역할 데이터(있으면 뒤에 추가)
    const originalAuthors = [
      ...findStringArray(pool, ["originalAuthor", "originalAuthors", "original", "originalCreators"]),
      ...findStringArray(pool, ["originalWriter", "originalWriters"]),
    ];

    const adapters = [
      ...findStringArray(pool, ["adapter", "adapters", "adaptation", "adaptations"]),
      ...findStringArray(pool, ["scenario", "scenarios", "script", "scripts"]),
    ];

    const artists = [
      ...findStringArray(pool, ["artist", "artists", "drawer", "drawers"]),
      ...findStringArray(pool, ["illustrator", "illustrators"]),
    ];

    const authorName = buildAuthorLine({ baseAuthor, originalAuthors, adapters, artists });

    // 성인 여부
    const b1 = findFirstBool(pool, ["isAdult", "adult", "is19", "isAdultOnly", "adultOnly"]);
    let isAdult = b1 === null ? false : b1;
    if (!isAdult) isAdult = detectAdultFromText(html) || detectAdultFromText($("body").text());

    // 장르
    let genre = findStringArray(pool, ["genre", "genres", "category", "categories"]);
    genre = uniq(genre);

    title = stripWebtoonSuffix(title).trim();

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "KAKAO",
      title,
      coverUrl,
      authorName: authorName || cleanBaseAuthor(baseAuthor) || "",
      publisherName: "",
      genre,
      desc,
      isAdult,
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
