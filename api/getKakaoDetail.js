// /api/getKakaoDetail.js  (카카오웹툰)
// ✅ 목표: "각색 / 그림 / 원작" 제작진을 authorName(작가명)에 합쳐서 내려주기
// - 예: "홍슬 · 원작: 마지노선 · 각색: 홍슬 · 그림: 누구"
// - platform: "카카오웹툰"
// - title: " | 카카오웹툰" 제거
// - 19세 여부(isAdult)는 내려주되, 키워드에 19를 추가하지 않는 건 addToNotion.js에서 처리됨
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

function buildAuthorLine({ baseAuthor, originalAuthors, adapters, artists }) {
  // ✅ 핵심: 각색/그림/원작을 authorName 문자열에 포함
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

    // 기본 OG
    const ogTitle = pickMeta($, "og:title");
    const ogDesc  = pickMeta($, "og:description");
    const ogImage = absolutize(pickMeta($, "og:image"));

    let title = stripWebtoonSuffix(ogTitle) || stripWebtoonSuffix($("title").text()) || "";
    let desc  = normalizeNotionText(ogDesc);
    let coverUrl = ogImage;

    // 데이터 풀(Next + Apollo)에서 최대한 뽑기
    const nextDataText = $("#__NEXT_DATA__").text() || "";
    const nextData = safeJsonParse(nextDataText);

    let apollo = null;
    const scripts = $("script").toArray().map((s) => $(s).text()).join("\n");
    const apolloMatch = scripts.match(/__APOLLO_STATE__\s*=\s*({.*?})\s*;\s*\n/s);
    if (apolloMatch && apolloMatch[1]) apollo = safeJsonParse(apolloMatch[1]);

    const pool = deepCollect(nextData, []);
    deepCollect(apollo, pool);

    // 제목/소개 보강
    const t2 = findFirstString(pool, ["title", "seoTitle", "contentTitle", "name"]);
    if (!title && t2) title = stripWebtoonSuffix(t2);

    const d2 = findFirstString(pool, ["synopsis", "description", "desc", "summary", "introduce", "introduction"]);
    if (d2) desc = normalizeNotionText(d2);

    // 표지 보강
    const img2 = findFirstString(pool, ["coverImage", "coverUrl", "thumbnailUrl", "thumbnail", "image", "imageUrl", "poster"]);
    if (!coverUrl && img2) coverUrl = absolutize(img2);

    // ✅ 작가/제작진 수집
    const baseAuthor =
      findFirstString(pool, ["authorName", "author", "writer", "creator", "creators"]) || "";

    // 원작(Original)
    const originalAuthors = [
      ...findStringArray(pool, ["originalAuthor", "originalAuthors", "original", "originalCreators"]),
      // 자주 쓰이는 다른 키도 대비
      ...findStringArray(pool, ["originalWriter", "originalWriters"]),
    ];

    // 각색(Adaptation/Scenario)
    const adapters = [
      ...findStringArray(pool, ["adapter", "adapters", "adaptation", "adaptations"]),
      ...findStringArray(pool, ["scenario", "scenarios", "script", "scripts"]),
    ];

    // 그림(Artist/Illustrator/Drawer)
    const artists = [
      ...findStringArray(pool, ["artist", "artists", "drawer", "drawers"]),
      ...findStringArray(pool, ["illustrator", "illustrators"]),
    ];

    const authorName = buildAuthorLine({ baseAuthor, originalAuthors, adapters, artists });

    // 성인 여부
    const b1 = findFirstBool(pool, ["isAdult", "adult", "is19", "isAdultOnly", "adultOnly"]);
    let isAdult = b1 === null ? false : b1;
    if (!isAdult) isAdult = detectAdultFromText(html) || detectAdultFromText($("body").text());

    // 장르(필요하면 내려주되, 이상값은 프론트/노션에서 처리 가능)
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
      // publisherName은 너 요청대로 쓰지 않는 방향(미리보기/저장 모두)
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
