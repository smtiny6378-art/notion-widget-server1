// /api/getKakaoDetail.js
const cheerio = require("cheerio");

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function absolutize(u) {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  if (u.startsWith("//")) return "https:" + u;
  return "https://webtoon.kakao.com" + u;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean)));
}

function normalizeGenreValue(v) {
  if (!v) return [];
  if (Array.isArray(v)) return uniq(v);
  if (typeof v === "string") return uniq(v.split(/[,/|]/g).map(s => s.trim()));
  return [];
}

function titleFromKakaoUrl(url) {
  try {
    const u = String(url || "").trim();
    const m = u.match(/\/content\/([^/]+)\/(\d+)/);
    if (!m) return "";
    const slug = decodeURIComponent(m[1]);
    return slug.replace(/-/g, " ").trim();
  } catch {
    return "";
  }
}

function extractContentId(url) {
  const u = String(url || "");
  // /content/작품명/2760
  const m = u.match(/\/content\/[^/]+\/(\d+)/);
  if (m) return m[1];
  // 혹시 /content/2760 형태
  const m2 = u.match(/\/content\/(\d+)/);
  if (m2) return m2[1];
  return "";
}

// JSON-LD에서 author/genre 뽑기(가능하면)
function parseJsonLd($) {
  let authorName = "";
  let genre = [];

  const scripts = $("script[type='application/ld+json']").toArray();
  for (const s of scripts) {
    const raw = $(s).text();
    if (!raw) continue;

    const data = safeJsonParse(raw);
    if (!data) continue;

    const nodes = Array.isArray(data) ? data : [data];

    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;

      const takeName = (x) => {
        if (!x) return [];
        if (typeof x === "string") return [x.trim()];
        if (Array.isArray(x)) return x.flatMap(takeName);
        if (typeof x === "object") return x.name ? [String(x.name).trim()] : [];
        return [];
      };

      if (!authorName) {
        const names = uniq([
          ...takeName(node.author),
          ...takeName(node.creator),
          ...takeName(node.contributor),
        ]);
        if (names.length) authorName = names.join(", ");
      }

      if (genre.length === 0) {
        genre = normalizeGenreValue(node.genre);
      }
      if (genre.length === 0 && node.keywords) {
        genre = normalizeGenreValue(node.keywords);
      }

      if (authorName || genre.length) break;
    }

    if (authorName || genre.length) break;
  }

  return { authorName, genre };
}

// 내부 API 응답(JSON)에서 작가/장르를 최대한 넓게 추출
function extractAuthorGenreFromApiJson(j) {
  let authorName = "";
  let genre = [];

  const pickNames = (x) => {
    if (!x) return [];
    if (typeof x === "string") return [x.trim()];
    if (Array.isArray(x)) return x.flatMap(pickNames);
    if (typeof x === "object") {
      if (x.name) return [String(x.name).trim()];
      if (x.penName) return [String(x.penName).trim()];
    }
    return [];
  };

  // 후보 키들(구조가 바뀔 수 있어서 넓게)
  const authorRoots = [
    j.author, j.authors, j.creator, j.creators, j.contributor, j.contributors,
    j.writer, j.writers, j.artist, j.artists,
    j.content?.author, j.content?.authors, j.content?.creators,
    j.result?.author, j.result?.authors, j.data?.author, j.data?.authors,
  ];

  const names = uniq(authorRoots.flatMap(pickNames)).filter(s => s.length <= 50);
  if (names.length) authorName = names.join(", ");

  const genreRoots = [
    j.genre, j.genres, j.category, j.categories, j.tags,
    j.content?.genre, j.content?.genres, j.content?.categories,
    j.result?.genre, j.result?.genres, j.data?.genre, j.data?.genres,
  ];

  const genreNames = uniq(genreRoots.flatMap(pickNames)).filter(s => s.length <= 30);
  if (genreNames.length) genre = genreNames.slice(0, 5);

  return { authorName, genre };
}

async function tryFetchJson(url, headers) {
  try {
    const r = await fetch(url, { headers, redirect: "follow" });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    // json이 아니어도 body가 json일 때가 있어서 그냥 텍스트로 파싱
    const text = await r.text();
    const j = safeJsonParse(text);
    return j || null;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  try {
    const url = (req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "Referer": "https://webtoon.kakao.com/",
    };

    const r = await fetch(url, { headers, redirect: "follow" });
    const html = await r.text();
    const $ = cheerio.load(html);

    const ogTitle = $("meta[property='og:title']").attr("content")?.trim() || "";
    const ogDesc = $("meta[property='og:description']").attr("content")?.trim() || "";
    const ogImage = $("meta[property='og:image']").attr("content")?.trim() || "";

    let title = ogTitle || $("h1,h2,h3").first().text().trim() || "";
    if (!title) title = titleFromKakaoUrl(url);

    const desc = ogDesc || "";
    const cover = absolutize(ogImage);
    const isAdult = html.includes("19세") || html.includes("성인");

    // 1) JSON-LD 시도
    let { authorName, genre } = parseJsonLd($);

    // 2) 내부 API fallback 시도 (작가/장르가 비거나 부족할 때)
    const contentId = extractContentId(url);
    let usedApi = "";
    if (contentId && (!authorName || genre.length === 0)) {
      const candidates = [
        // ✅ 가장 흔한 패턴들 (가능한 걸 “자동으로” 시도)
        `https://webtoon.kakao.com/api/v1/content/${contentId}`,
        `https://webtoon.kakao.com/api/v1/contents/${contentId}`,
        `https://webtoon.kakao.com/api/v2/content/${contentId}`,
        `https://webtoon.kakao.com/api/v2/contents/${contentId}`,
        `https://webtoon.kakao.com/api/v1/content/${contentId}/detail`,
        `https://webtoon.kakao.com/api/v1/contents/${contentId}/detail`,
        `https://webtoon.kakao.com/api/v1/content/${contentId}/home`,
        `https://webtoon.kakao.com/api/v1/contents/${contentId}/home`,
      ];

      for (const apiUrl of candidates) {
        const j = await tryFetchJson(apiUrl, {
          ...headers,
          Accept: "application/json,text/plain,*/*",
        });
        if (!j) continue;

        const picked = extractAuthorGenreFromApiJson(j);
        if (!authorName && picked.authorName) authorName = picked.authorName;
        if (genre.length === 0 && picked.genre.length) genre = picked.genre;

        usedApi = apiUrl;
        if (authorName && genre.length) break;
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      title,
      authorName,
      genre,
      desc,
      cover,
      isAdult,
      url,
      // 디버그(문제 계속이면 어떤 API가 됐는지 확인용)
      ...(req.query.debug ? { contentId, usedApi } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
