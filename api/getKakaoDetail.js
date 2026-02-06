// /api/getKakaoDetail.js  (카카오웹툰)
// ✅ 목표
// 1) 제목에서 " | 카카오웹툰" 제거
// 2) authorName(작가명)에 섞여 들어오는 "작가: (작품명)", "(장르)", "로맨스 판타지/드라마" 같은 불필요 토큰 제거
// 3) (가능한 경우) 원작/각색/그림 제작진을 authorName에 합쳐서 출력
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

// ----------------- 핵심: "사람 이름만" 남기는 정리 -----------------
function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[·:：\-\–—_()［］\[\]{}<>|/\\'"“”‘’.,!?]/g, "");
}

function stripParens(s) {
  // 괄호 안 텍스트 제거: "(장르)" "(로맨스 판타지)" 등
  return String(s || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

function isGenreToken(token) {
  const t = String(token || "").trim();
  if (!t) return true;

  const low = t.toLowerCase().replace(/\s+/g, "");

  // 너무 흔한/분류성 토큰들
  const genreWords = [
    "로맨스", "로맨스판타지", "판타지", "드라마", "액션", "스릴러", "공포", "미스터리",
    "코미디", "일상", "스포츠", "무협", "학원", "BL", "GL", "성인", "19", "19세",
    "웹툰", "웹소설", "연재", "완결", "시즌", "시즌1", "시즌2"
  ];

  if (genreWords.includes(low)) return true;

  // "~판타지" "~로맨스" 같은 꼬리 패턴
  if (/(판타지|로맨스|드라마|액션|무협|스릴러|공포|미스터리|코미디|일상)$/.test(t)) return true;

  // "로판" 같은 축약
  if (low === "로판") return true;

  return false;
}

function splitPeople(s) {
  // 쉼표/가운뎃점/슬래시/세로줄 등으로 분리
  return String(s || "")
    .replace(/^작가\s*[:：]\s*/g, "") // "작가:" 제거
    .replace(/^제작\s*[:：]\s*/g, "")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/\s*·\s*/g, ", ")
    .replace(/\s*\/\s*/g, ", ")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function cleanPeopleList(raw, titleForFilter) {
  const titleKey = normKey(titleForFilter);
  const out = [];

  const tokens = splitPeople(stripParens(raw));

  for (const tok0 of tokens) {
    let tok = tok0.trim();
    if (!tok) continue;

    // "작가: 작품명" 같이 들어온 경우: 작품명이면 제거
    const tokKey = normKey(tok);

    // 제목과 동일/포함이면 제거
    if (titleKey && (tokKey === titleKey || tokKey.includes(titleKey) || titleKey.includes(tokKey))) {
      continue;
    }

    // 장르/분류 토큰 제거
    if (isGenreToken(tok)) continue;

    // 너무 길면(설명문일 가능성) 제거
    if (tok.length > 40) continue;

    // "작가" 같은 라벨만 남은 토큰 제거
    if (tok === "작가" || tok === "제작" || tok === "작가명") continue;

    out.push(tok);
  }

  return uniq(out);
}

// 제작진 라인 구성
function joinPeople(arr) {
  return uniq(arr).join(", ");
}

function buildAuthorLine({ basePeople, originalAuthors, adapters, artists }) {
  const parts = [];

  if (basePeople.length) parts.push(joinPeople(basePeople));

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

    title = stripWebtoonSuffix(title).trim();

    // ✅ base author(이름 나열일 수도, 잡다한 정보 섞일 수도 있음)
    const baseAuthorRaw =
      findFirstString(pool, ["authorName", "author", "writer", "creator", "creators"]) || "";

    // ✅ 역할 데이터(있는 경우)
    const originalAuthorsRaw = [
      ...findStringArray(pool, ["originalAuthor", "originalAuthors", "original", "originalCreators"]),
      ...findStringArray(pool, ["originalWriter", "originalWriters"]),
    ];

    const adaptersRaw = [
      ...findStringArray(pool, ["adapter", "adapters", "adaptation", "adaptations"]),
      ...findStringArray(pool, ["scenario", "scenarios", "script", "scripts"]),
    ];

    const artistsRaw = [
      ...findStringArray(pool, ["artist", "artists", "drawer", "drawers"]),
      ...findStringArray(pool, ["illustrator", "illustrators"]),
    ];

    // ✅ 여기서 "사람 이름만" 남기기 (제목/장르/라벨 제거)
    const basePeople = cleanPeopleList(baseAuthorRaw, title);

    const originalAuthors = uniq(originalAuthorsRaw.flatMap(x => cleanPeopleList(x, title)));
    const adapters = uniq(adaptersRaw.flatMap(x => cleanPeopleList(x, title)));
    const artists = uniq(artistsRaw.flatMap(x => cleanPeopleList(x, title)));

    // 성인 여부
    const b1 = findFirstBool(pool, ["isAdult", "adult", "is19", "isAdultOnly", "adultOnly"]);
    let isAdult = b1 === null ? false : b1;
    if (!isAdult) isAdult = detectAdultFromText(html) || detectAdultFromText($("body").text());

    // 장르(원하면 유지; 지금은 프론트에서 쓰기도 하니 그대로)
    let genre = findStringArray(pool, ["genre", "genres", "category", "categories"]);
    genre = uniq(genre);

    const authorName = buildAuthorLine({ basePeople, originalAuthors, adapters, artists });

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      title,
      coverUrl,
      authorName: authorName || "",   // ✅ 이제 불필요 토큰이 섞이지 않도록 정리됨
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
