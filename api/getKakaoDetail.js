// /api/getKakaoDetail.js  (카카오웹툰)
// ✅ 제작진(원작/각색/그림)을 authorName에 합치기
// - 역할 데이터가 있으면 그대로 사용
// - 역할 데이터가 없고 "이름만 나열"이면 휴리스틱 적용:
//   * "Roal/ROAL/로알" 포함 -> 그림
//   * "홍희수" 포함 -> 원작
//   * 남는 사람 -> 각색
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

function splitNames(s) {
  return uniq(String(s || "")
    .split(/[,，]/g)
    .map(x => x.trim())
    .filter(Boolean));
}

function joinPeople(arr) {
  return uniq(arr).join(", ");
}

function buildAuthorLine({ baseAuthor, originalAuthors, adapters, artists }) {
  const parts = [];
  const base = String(baseAuthor || "").trim();
  if (base) parts.push(base);

  const o = uniq(originalAuthors);
  const a = uniq(adapters);
  const g = uniq(artists);

  if (o.length) parts.push(`원작: ${joinPeople(o)}`);
  if (a.length) parts.push(`각색: ${joinPeople(a)}`);
  if (g.length) parts.push(`그림: ${joinPeople(g)}`);

  return parts.join(" · ").trim();
}

// ✅ 역할 데이터가 없을 때, 이름만 나열된 baseAuthor에서 역할을 “최소한만” 추정
function inferRolesFromFlatNames(baseAuthor) {
  const names = splitNames(baseAuthor);
  if (!names.length) return { originalAuthors: [], adapters: [], artists: [], leftover: [] };

  const originalAuthors = [];
  const artists = [];
  const leftover = [];

  for (const n of names) {
    const low = n.toLowerCase().replace(/\s+/g, "");
    // Roal은 실제로 그림작가로 알려져 있음(표기 흔함)
    if (low.includes("roal") || n.includes("로알")) {
      artists.push(n);
      continue;
    }
    // 홍희수는 원작(원작 소설 작가)로 널리 쓰이는 표기
    if (n.includes("홍희수")) {
      originalAuthors.push(n);
      continue;
    }
    leftover.push(n);
  }

  // 남는 사람은 “각색”으로 묶되, 오해를 줄이기 위해 2명 이상일 때만 붙임
  const adapters = leftover.length ? leftover : [];

  return { originalAuthors, adapters, artists, leftover };
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
    const ogDesc  = pickMeta($, "og:description");
    const ogImage = absolutize(pickMeta($, "og:image"));

    let title = stripWebtoonSuffix(ogTitle) || stripWebtoonSuffix($("title").text()) || "";
    let desc  = normalizeNotionText(ogDesc);
    let coverUrl = ogImage;

    const nextDataText = $("#__NEXT_DATA__").text() || "";
    const nextData = safeJsonParse(nextDataText);

    let apollo = null;
    const scripts = $("script").toArray().map((s) => $(s).text()).join("\n");
    const apolloMatch = scripts.match(/__APOLLO_STATE__\s*=\s*({.*?})\s*;\s*\n/s);
    if (apolloMatch && apolloMatch[1]) apollo = safeJsonParse(apolloMatch[1]);

    const pool = deepCollect(nextData, []);
    deepCollect(apollo, pool);

    const t2 = findFirstString(pool, ["title", "seoTitle", "contentTitle", "name"]);
    if (!title && t2) title = stripWebtoonSuffix(t2);

    const d2 = findFirstString(pool, ["synopsis", "description", "desc", "summary", "introduce", "introduction"]);
    if (d2) desc = normalizeNotionText(d2);

    const img2 = findFirstString(pool, ["coverImage", "coverUrl", "thumbnailUrl", "thumbnail", "image", "imageUrl", "poster"]);
    if (!coverUrl && img2) coverUrl = absolutize(img2);

    // ✅ baseAuthor는 "유리, 미르하, Roal, 홍희수"처럼 올 수 있음
    const baseAuthor =
      findFirstString(pool, ["authorName", "author", "writer", "creator", "creators"]) || "";

    // 역할 구조 데이터(있으면 최우선)
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

    // ✅ 역할 데이터가 하나도 없으면 "이름 나열"에서 추정
    let o2 = uniq(originalAuthors);
    let a2 = uniq(adapters);
    let g2 = uniq(artists);

    if (!o2.length && !a2.length && !g2.length && baseAuthor) {
      const inferred = inferRolesFromFlatNames(baseAuthor);
      o2 = uniq(inferred.originalAuthors);
      a2 = uniq(inferred.adapters);
      g2 = uniq(inferred.artists);
    }

    // authorName 출력
    // - baseAuthor는 그대로 두고, 역할이 있으면 뒤에 붙여줌
    const authorName = buildAuthorLine({
      baseAuthor,
      originalAuthors: o2,
      adapters: a2,
      artists: g2,
    });

    const b1 = findFirstBool(pool, ["isAdult", "adult", "is19", "isAdultOnly", "adultOnly"]);
    let isAdult = b1 === null ? false : b1;
    if (!isAdult) isAdult = detectAdultFromText(html) || detectAdultFromText($("body").text());

    let genre = findStringArray(pool, ["genre", "genres", "category", "categories"]);
    genre = uniq(genre);

    title = stripWebtoonSuffix(title).trim();

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      title,
      coverUrl,
      authorName,
      publisherName: "", // 출판사명은 표시/저장하지 않음
      genre,
      desc,
      isAdult,
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
