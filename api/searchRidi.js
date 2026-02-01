// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-01-v7-fix-empty-items+details";

function absolutizeUrl(u) {
  if (!u) return "";
  const url = String(u).trim();
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return "https://ridibooks.com" + url;
  return url;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function extractBookId(link) {
  const m = String(link || "").match(/\/books\/(\d+)/);
  return m ? m[1] : null;
}

// JSON 트리에서 특정 키 후보를 찾아 첫 값을 반환(문자열/배열/객체 모두)
function findInJson(root, keyCandidates) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }

    if (typeof cur === "object") {
      for (const k of Object.keys(cur)) {
        const v = cur[k];
        if (keyCandidates.includes(k)) return v;
        stack.push(v);
      }
    }
  }
  return null;
}

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags
      .map(t => (typeof t === "string" ? t.trim() : ""))
      .filter(Boolean)
      .slice(0, 12);
  }
  if (typeof tags === "string") {
    return tags
      .split(/[,#]/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

function normalizeText(v) {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

function normalizePeople(v) {
  if (!v) return "";
  if (typeof v === "string") return normalizeText(v);

  if (Array.isArray(v)) {
    const names = v.map(x => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") return x.name || x.displayName || x.authorName || x.writerName || "";
      return "";
    }).map(normalizeText).filter(Boolean);
    return Array.from(new Set(names)).join(", ");
  }

  if (typeof v === "object") {
    return normalizeText(v.name || v.displayName || v.authorName || v.writerName || "");
  }

  return "";
}

function normalizeStringArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    const out = v.map(x => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") return x.name || x.title || x.label || "";
      return "";
    }).map(s => String(s).trim()).filter(Boolean);
    return Array.from(new Set(out)).slice(0, 12);
  }
  if (typeof v === "string") {
    return v.split(/[,/|#]/g).map(s => s.trim()).filter(Boolean).slice(0, 12);
  }
  return [];
}

function toNumberSafe(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ✅ 검색 결과에서 제목 뽑기(alt/aria/text 다 실패하면 books/ID로 fallback)
function pickTitle($, a, link) {
  const alt = $(a).find("img").first().attr("alt");
  const aria = $(a).attr("aria-label");
  const text = $(a).text().replace(/\s+/g, " ").trim();

  let title = (alt && alt.trim()) || (aria && aria.trim()) || text || "";
  title = title.replace(/\s+/g, " ").trim();

  // 너무 길면 잘라내기(검색 결과에 종종 긴 문구가 섞임)
  if (title.length > 120) title = title.slice(0, 120);

  // 전부 실패하면 bookId로라도 채워서 items가 비지 않게
  if (!title) {
    const id = extractBookId(link);
    if (id) title = `RIDIBOOKS ${id}`;
  }
  return title;
}

async function fetchDetailAndExtract(bookLink) {
  const r = await fetch(bookLink, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "Referer": "https://ridibooks.com/",
    },
    redirect: "follow",
  });

  if (!r.ok) {
    return {
      coverUrl: null,
      isAdult: false,
      description: "",
      guide: "",
      authorName: "",
      publisherName: "",
      rating: null,
      genre: [],
      tags: [],
      reason: `detail status ${r.status}`,
    };
  }

  const html = await r.text();
  const $ = cheerio.load(html);

  // coverUrl: NEXT_DATA → og:image → ld+json image
  let coverUrl = null;
  let reason = "none";

  const nextText = $("#__NEXT_DATA__").first().text();
  const next = nextText ? safeJsonParse(nextText) : null;

  if (next) {
    const cover = findInJson(next, ["coverUrl", "thumbnailUrl", "thumbnail", "imageUrl", "image", "cover"]);
    if (typeof cover === "string" && cover.trim()) {
      coverUrl = absolutizeUrl(cover);
      reason = "next_data";
    }
  }

  if (!coverUrl) {
    const og =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[property="og:image:secure_url"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('meta[property="twitter:image"]').attr("content");
    if (og) {
      coverUrl = absolutizeUrl(og);
      reason = "og_meta";
    }
  }

  if (!coverUrl) {
    const ldTxt = $('script[type="application/ld+json"]').first().text();
    const j = ldTxt ? safeJsonParse(ldTxt) : null;
    const img =
      (j && typeof j === "object" && (j.image || (j.mainEntity && j.mainEntity.image))) || null;
    if (typeof img === "string" && img) {
      coverUrl = absolutizeUrl(img);
      reason = "ld_json";
    }
  }

  // isAdult: 성인 대체 표지로 판별
  const isAdult = Boolean(coverUrl && String(coverUrl).includes("cover_adult.png"));

  // 상세 필드들
  let description = "";
  let guide = "";
  let authorName = "";
  let publisherName = "";
  let rating = null;
  let genre = [];
  let tags = [];

  // 1) __NEXT_DATA__ 우선
  if (next) {
    const descVal = findInJson(next, [
      "description", "bookDescription", "synopsis", "summary",
      "intro", "introduction", "productDescription"
    ]);
    if (descVal) description = normalizeText(descVal);

    const guideVal = findInJson(next, [
      "romanceGuide", "romance_guide", "romanceGuideText",
      "guide", "contentGuide"
    ]);
    if (guideVal) guide = normalizeText(guideVal);

    const authorVal = findInJson(next, [
      "authorName", "author", "authors", "writer", "writers",
      "creator", "creators"
    ]);
    authorName = normalizePeople(authorVal);

    const pubVal = findInJson(next, [
      "publisherName", "publisher", "imprint", "brand"
    ]);
    publisherName = normalizeText(pubVal);

    const ratingVal = findInJson(next, [
      "averageRating", "ratingAverage", "rating", "score", "starRating"
    ]);
    rating = toNumberSafe(ratingVal);

    const genreVal = findInJson(next, [
      "genres", "genre", "categories", "category", "bookCategories", "classification"
    ]);
    genre = normalizeStringArray(genreVal);

    const keywordVal = findInJson(next, [
      "keywords", "keyword", "tags", "tagList", "hashTags", "hashtags"
    ]);
    tags = normalizeTags(keywordVal);
  }

  // 2) description fallback (og:description은 요약)
  if (!description) {
    const ogDesc =
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      "";
    if (ogDesc) description = normalizeText(ogDesc);
  }

  // 3) ld+json 보조
  const ldTxt = $('script[type="application/ld+json"]').first().text();
  const j = ldTxt ? safeJsonParse(ldTxt) : null;
  if (j && typeof j === "object") {
    if (!description && j.description) description = normalizeText(j.description);
    if (!authorName && j.author) authorName = normalizePeople(j.author);
    if (!publisherName && j.publisher) publisherName = normalizePeople(j.publisher);

    if (rating == null && j.aggregateRating && j.aggregateRating.ratingValue) {
      rating = toNumberSafe(j.aggregateRating.ratingValue);
    }

    if (j.keywords) {
      const ldTags = normalizeTags(j.keywords);
      const merged = [...tags, ...ldTags];
      tags = Array.from(new Set(merged)).slice(0, 12);
    }
  }

  return { coverUrl, isAdult, description, guide, authorName, publisherName, rating, genre, tags, reason };
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = (req.query?.q || "").toString().trim();
  const debug = req.query?.debug === "1";
  if (!q) return res.status(400).json({ ok: false, error: "q is required", version: VERSION });

  try {
    const searchUrl = `https://ridibooks.com/search?q=${encodeURIComponent(q)}`;
    const r = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });

    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `search fetch failed: ${r.status}`, version: VERSION });
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    // ✅ 검색 페이지에서 /books/ 링크를 최대한 모은다 (q 포함 필터 제거)
    const items = [];
    const seenId = new Set();

    $("a[href*='/books/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (!href.includes("/books/")) return;

      const link = href.startsWith("http") ? href : `https://ridibooks.com${href}`;
      const bookId = extractBookId(link);
      if (!bookId) return;

      // 동일 bookId 중복 제거
      if (seenId.has(bookId)) return;
      seenId.add(bookId);

      const title = pickTitle($, a, link);
      items.push({ title, link, bookId });
    });

    // ✅ 결과가 0이면: HTML 구조가 바뀐 케이스 → debug로 일부 HTML 길이/링크 수 반환
    if (items.length === 0) {
      return res.status(200).json({
        ok: true,
        q,
        items: [],
        version: VERSION,
        debug: debug ? { note: "no /books/ links found", htmlLength: html.length } : undefined,
      });
    }

    const top = items.slice(0, 12);

    // 상세 페이지에서 필드 채우기 (상위 8개)
    const DETAIL_LIMIT = 8;
    const debugDetails = [];

    for (let i = 0; i < top.length && i < DETAIL_LIMIT; i++) {
      const it = top[i];
      const d = await fetchDetailAndExtract(it.link);

      it.coverUrl = d.coverUrl || undefined;
      it.isAdult = Boolean(d.isAdult);

      // 저장용 데이터(리스트 표시 안 해도 됨)
      it.description = d.description || "";
      it.guide = d.guide || "";
      it.authorName = d.authorName || "";
      it.publisherName = d.publisherName || "";
      it.rating = d.rating == null ? undefined : d.rating;
      it.genre = d.genre || [];
      it.tags = d.tags || []; // (=키워드로 사용)

      if (debug) {
        debugDetails.push({
          i,
          bookId: it.bookId,
          title: it.title,
          reason: d.reason,
          hasCover: Boolean(d.coverUrl),
          isAdult: it.isAdult,
          hasDesc: Boolean(d.description),
          hasAuthor: Boolean(d.authorName),
          hasPublisher: Boolean(d.publisherName),
          hasRating: d.rating != null,
          genreCount: (d.genre || []).length,
          tagsCount: (d.tags || []).length,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      q,
      items: top,
      version: VERSION,
      ...(debug ? { debug: { detail: debugDetails, foundCount: items.length } } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e), version: VERSION });
  }
};
