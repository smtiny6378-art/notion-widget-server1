// /api/getKakaoDetail.js  (카카오웹툰) - 조정 버전
// ✅ 목표
// - 작가명(authorName)은 절대 빈 값이 되지 않게 보장(fallback)
// - 하지만 "작가: (작품명)", "(장르)", "로맨스 판타지/드라마" 같은 불필요 토큰은 최대한 제거
// - 역할 데이터(원작/각색/그림)가 있으면 authorName에 덧붙임
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

// ----------------- authorName 정리 로직(안전 + fallback) -----------------
function cleanBaseAuthorMin(s) {
  // 최소 정리(절대 비우지 않기 위한 최후 fallback용)
  let t = String(s || "").trim();
  t = t.replace(/^작가\s*[:：]\s*/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}
function stripParens(s) {
  // 괄호 안 텍스트는 보통 장르/부가정보라 제거
  return String(s || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}
function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[·:：\-\–—_()［］\[\]{}<>|/\\'"“”‘’.,!?]/g, "");
}
function splitPeople(s) {
  return String(s || "")
    .replace(/^작가\s*[:：]\s*/g, "")
    .replace(/^제작\s*[:：]\s*/g, "")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/\s*·\s*/g, ", ")
    .replace(/\s*\/\s*/g, ", ")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
function isLikelyGenreToken(tok) {
  const t = String(tok || "").trim();
  if (!t) return true;
  const low = t.toLowerCase().replace(/\s+/g, "");

  const genreWords = new Set([
    "로맨스","로맨스판타지","판타지","드라마","액션","스릴러","공포","미스터리","코미디",
    "일상","스포츠","무협","학원","bl","gl","성인","19","19세","웹툰","웹소설","연재","완결",
    "로판"
  ]);
  if (genreWords.has(low)) return true;
  if (/(판타지|로맨스|드라마|액션|무협|스릴러|공포|미스터리|코미디|일상)$/.test(t)) return true;
  return false;
}
function cleanPeopleListSafe(raw, titleForFilter) {
  // ✅ "너무 세게 걸러서 빈 값"이 되면 안 되므로:
  // 1) 후보 토큰을 만든다
  // 2) 제목/장르/라벨 같은 확실한 것만 제거한다
  // 3) 결과가 비면 -> 빈 배열 반환(상위에서 fallback)
  const titleKey = normKey(titleForFilter);
  const tokens = splitPeople(stripParens(raw));
  const out = [];

  for (const tok0 of tokens) {
    const tok = tok0.trim();
    if (!tok) continue;

    const k = normKey(tok);
    if (!k) continue;

    // 제목과 동일/포함이면 제거(작가에 작품명 붙는 케이스)
    if (titleKey && (k === titleKey || k.includes(titleKey) || titleKey.includes(k))) continue;

    // 장르 단어 제거
    if (isLikelyGenreToken(tok)) continue;

    // 라벨만 남은 토큰 제거
    if (tok === "작가" || tok === "제작" || tok === "작가명") continue;

    // 너무 긴 건 설명문일 확률이 높아 제거(하지만 50자까지는 허용)
    if (tok.length > 50) continue;

    out.push(tok);
  }
  return uniq(out);
}

function joinPeople(arr) {
  return uniq(arr).join(", ");
}

function buildAuthorLine({ baseAuthorRaw, title, originalAuthors, adapters, artists }) {
  const baseMin = cleanBaseAuthorMin(baseAuthorRaw);

  // 1) 안전 필터 적용
  const cleanedList = cleanPeopleListSafe(baseAuthorRaw, title);

  // 2) 결과가 비면 -> 최소 정리 원본으로 fallback
  const base = cleanedList.length ? joinPeople(cleanedList) : baseMin;

  const parts = [];
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

    // OG
    const ogTitle = pickMeta($, "og:title");
    const ogDesc  = pickMeta($, "og:description");
    const ogImage = absolutize(pickMeta($, "og:image"));

    let title = stripWebtoonSuffix(ogTitle) || stripWebtoonSuffix($("title").text()) || "";
    let desc  = normalizeNotionText(ogDesc);
    let coverUrl = ogImage;

    // Next/Apollo 풀
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

    title = stripWebtoonSuffix(title).trim();

    // base author
    const baseAuthorRaw =
      findFirstString(pool, ["authorName", "author", "writer", "creator", "creators"]) || "";

    // 역할 데이터
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

    const authorName = buildAuthorLine({
      baseAuthorRaw,
      title,
      originalAuthors,
      adapters,
      artists,
    });

    // 성인
    const b1 = findFirstBool(pool, ["isAdult", "adult", "is19", "isAdultOnly", "adultOnly"]);
    let isAdult = b1 === null ? false : b1;
    if (!isAdult) isAdult = detectAdultFromText(html) || detectAdultFromText($("body").text());

    // 장르
    let genre = findStringArray(pool, ["genre", "genres", "category", "categories"]);
    genre = uniq(genre);

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "KAKAO",
      title,
      coverUrl,
      authorName: authorName || cleanBaseAuthorMin(baseAuthorRaw) || "",
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
