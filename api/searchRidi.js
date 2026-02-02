// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-02-v10-dom+ldjson(author/publisher/rating)+better-title+guide";

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

function normalizeText(v) {
  if (v == null) return "";
  return String(v)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(s) {
  let t = normalizeText(s);
  if (!t) return "";

  // "무정의 봄 - 최신권 독점 업데이트!" 같은 마케팅 꼬리 제거(가장 흔한 패턴들)
  t = t.replace(/\s*[-|｜]\s*최신권.*$/g, "").trim();
  t = t.replace(/\s*[-|｜]\s*독점.*$/g, "").trim();
  t = t.replace(/\s*[-|｜]\s*리디.*$/gi, "").trim();

  // 그래도 너무 길면 컷
  if (t.length > 120) t = t.slice(0, 120);
  return t;
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

function toNumberSafe(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// 검색 결과에서 제목 뽑기
function pickTitle($, a, link) {
  const alt = $(a).find("img").first().attr("alt");
  const aria = $(a).attr("aria-label");
  const text = $(a).text().replace(/\s+/g, " ").trim();

  let title = (alt && alt.trim()) || (aria && aria.trim()) || text || "";
  title = cleanTitle(title);

  if (!title) {
    const id = extractBookId(link);
    if (id) title = `RIDIBOOKS ${id}`;
  }
  return title;
}

function cleanSectionText(s) {
  return normalizeText(s)
    .replace(/\s*더보기\s*$/g, "")
    .replace(/\s*접기\s*$/g, "")
    .trim();
}

// 섹션: "작품 소개", "로맨스 가이드" 등
function extractSectionByHeading($, headingCandidates, minLen = 80) {
  const candidates = headingCandidates.map(h => normalizeText(h));
  const all = $("body *").toArray();

  let headingEl = null;
  for (const el of all) {
    const t = normalizeText($(el).text());
    if (!t) continue;
    if (t.length > 30) continue;
    if (candidates.some(h => t === h || t.includes(h))) {
      headingEl = el;
      break;
    }
  }
  if (!headingEl) return "";

  const $h = $(headingEl);
  const scopes = [];

  scopes.push($h.parent());
  scopes.push($h.parent().parent());
  scopes.push($h.parent().parent().parent());

  // heading 다음 형제들
  let next = $h.next();
  let steps = 0;
  while (next && next.length && steps < 8) {
    scopes.push(next);
    next = next.next();
    steps++;
  }

  let best = "";
  for (const $scope of scopes) {
    if (!$scope || !$scope.length) continue;
    const txt = cleanSectionText($scope.text());
    if (!txt) continue;

    let cleaned = txt;
    for (const h of candidates) cleaned = cleaned.replace(h, "").trim();
    cleaned = cleaned.replace(/^[:：\-–—]\s*/g, "");

    if (cleaned.length > best.length) best = cleaned;
  }

  if (best.length < minLen) return "";
  return best.slice(0, 50000); // 충분히 길게
}

// DOM에서 "라벨: 값" 형태(작가/출판사/평점) 뽑기
function extractValueByLabel($, labelCandidates) {
  const labels = labelCandidates.map(x => normalizeText(x));
  const all = $("body *").toArray();

  for (const el of all) {
    const t = normalizeText($(el).text());
    if (!t) continue;
    if (t.length > 20) continue;

    if (!labels.some(lb => t === lb || t.includes(lb))) continue;

    // 1) 다음 형제
    const next = $(el).next();
    if (next && next.length) {
      const v = normalizeText(next.text());
      if (v && v.length <= 80) return v;
    }

    // 2) 부모 영역에서 라벨 제외한 짧은 값 찾기
    const parent = $(el).parent();
    if (parent && parent.length) {
      const full = normalizeText(parent.text());
      let cleaned = full;
      for (const lb of labels) cleaned = cleaned.replace(lb, "").trim();
      cleaned = cleaned.replace(/^[:：\-–—]\s*/g, "").trim();
      // 너무 길면 실패로 보고 다음으로
      if (cleaned && cleaned.length <= 80) return cleaned;
    }
  }
  return "";
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
      titleFromDetail: "",
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
      debug_from: { title: "none", description: "none", guide: "none", author: "none", publisher: "none", rating: "none" },
    };
  }

  const html = await r.text();
  const $ = cheerio.load(html);

  // ---- JSON sources ----
  const ldTxt = $('script[type="application/ld+json"]').first().text();
  const ldObj = ldTxt ? safeJsonParse(ldTxt) : null;

  const nextText = $("#__NEXT_DATA__").first().text();
  const next = nextText ? safeJsonParse(nextText) : null;

  // ---- title ----
  let titleFromDetail = "";
  const ogTitle =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    "";
  if (ogTitle) titleFromDetail = cleanTitle(ogTitle);

  if (!titleFromDetail && ldObj && typeof ldObj === "object" && ldObj.name) {
    titleFromDetail = cleanTitle(ldObj.name);
  }

  if (!titleFromDetail && next) {
    const t = findInJson(next, ["title", "bookTitle", "productTitle", "name"]);
    if (typeof t === "string" && t.trim()) titleFromDetail = cleanTitle(t);
  }

  let debugTitleFrom = titleFromDetail ? "og_or_ld_or_next" : "none";

  // ---- cover ----
  let coverUrl = null;
  let reason = "none";

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

  if (!coverUrl && ldObj) {
    const img = (ldObj.image || (ldObj.mainEntity && ldObj.mainEntity.image)) || null;
    if (typeof img === "string" && img) {
      coverUrl = absolutizeUrl(img);
      reason = "ld_json";
    }
  }

  const isAdult = Boolean(coverUrl && String(coverUrl).includes("cover_adult.png"));

  // ---- fields ----
  let description = "";
  let guide = "";
  let authorName = "";
  let publisherName = "";
  let rating = null;
  let genre = [];
  let tags = [];

  let debugDescFrom = "none";
  let debugGuideFrom = "none";
  let debugAuthorFrom = "none";
  let debugPublisherFrom = "none";
  let debugRatingFrom = "none";

  // 1) next_data
  if (next) {
    const descVal = findInJson(next, [
      "description", "bookDescription", "synopsis", "summary",
      "intro", "introduction", "productDescription", "fullDescription"
    ]);
    if (descVal) {
      description = normalizeText(descVal);
      debugDescFrom = "next_data";
    }

    const guideVal = findInJson(next, [
      "romanceGuide", "romance_guide", "romanceGuideText",
      "guide", "contentGuide"
    ]);
    if (guideVal) {
      guide = normalizeText(guideVal);
      debugGuideFrom = "next_data";
    }

    const authorVal = findInJson(next, [
      "authorName", "author", "authors", "writer", "writers",
      "creator", "creators"
    ]);
    const a = normalizePeople(authorVal);
    if (a) {
      authorName = a;
      debugAuthorFrom = "next_data";
    }

    const pubVal = findInJson(next, [
      "publisherName", "publisher", "imprint", "brand"
    ]);
    const p = normalizeText(pubVal);
    if (p) {
      publisherName = p;
      debugPublisherFrom = "next_data";
    }

    const ratingVal = findInJson(next, [
      "averageRating", "ratingAverage", "rating", "score", "starRating"
    ]);
    const rn = toNumberSafe(ratingVal);
    if (rn != null) {
      rating = rn;
      debugRatingFrom = "next_data";
    }

    const genreVal = findInJson(next, [
      "genres", "genre", "categories", "category", "bookCategories", "classification"
    ]);
    genre = normalizeStringArray(genreVal);

    const keywordVal = findInJson(next, [
      "keywords", "keyword", "tags", "tagList", "hashTags", "hashtags"
    ]);
    tags = normalizeTags(keywordVal);
  }

  // 2) DOM 섹션 (소개/가이드)
  const domDesc = extractSectionByHeading($, ["작품 소개", "작품소개", "책 소개", "줄거리", "소개"], 120);
  if (domDesc) {
    description = domDesc;
    debugDescFrom = "dom_section";
  }

  const domGuide = extractSectionByHeading($, ["로맨스 가이드", "로맨스가이드", "가이드"], 80);
  if (domGuide) {
    guide = domGuide;
    debugGuideFrom = "dom_section";
  }

  // 3) ld+json (author/publisher/rating)
  if (ldObj && typeof ldObj === "object") {
    if (!authorName && ldObj.author) {
      const a =
        Array.isArray(ldObj.author)
          ? ldObj.author.map(x => x?.name || "").filter(Boolean).join(", ")
          : (ldObj.author?.name || "");
      if (a) {
        authorName = normalizeText(a);
        debugAuthorFrom = "ld_json";
      }
    }

    if (!publisherName && ldObj.publisher) {
      const p =
        Array.isArray(ldObj.publisher)
          ? ldObj.publisher.map(x => x?.name || "").filter(Boolean).join(", ")
          : (ldObj.publisher?.name || ldObj.publisher || "");
      if (p) {
        publisherName = normalizeText(p);
        debugPublisherFrom = "ld_json";
      }
    }

    if (rating == null && ldObj.aggregateRating) {
      const rv = ldObj.aggregateRating.ratingValue || ldObj.aggregateRating.rating || null;
      const rn = toNumberSafe(rv);
      if (rn != null) {
        rating = rn;
        debugRatingFrom = "ld_json";
      }
    }
  }

  // 4) DOM 라벨 (author/publisher/rating) 마지막 보험
  if (!authorName) {
    const v = extractValueByLabel($, ["작가", "작가명", "저자", "Author"]);
    if (v) {
      authorName = v;
      debugAuthorFrom = "dom_label";
    }
  }

  if (!publisherName) {
    const v = extractValueByLabel($, ["출판사", "출판사명", "Publisher"]);
    if (v) {
      publisherName = v;
      debugPublisherFrom = "dom_label";
    }
  }

  if (rating == null) {
    const v = extractValueByLabel($, ["평점", "별점", "Rating"]);
    const rn = toNumberSafe(v);
    if (rn != null) {
      rating = rn;
      debugRatingFrom = "dom_label";
    }
  }

  // 5) og:description fallback
  if (!description) {
    const ogDesc =
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      "";
    if (ogDesc) {
      description = normalizeText(ogDesc);
      debugDescFrom = "og_description";
    }
  }

  // 6) ld+json keywords 섞기
  if (ldObj && typeof ldObj === "object" && ldObj.keywords) {
    const ldTags = normalizeTags(ldObj.keywords);
    const merged = [...tags, ...ldTags];
    tags = Array.from(new Set(merged)).slice(0, 12);
  }

  return {
    titleFromDetail,
    coverUrl,
    isAdult,
    description,
    guide,
    authorName,
    publisherName,
    rating,
    genre,
    tags,
    reason,
    debug_from: {
      title: debugTitleFrom,
      description: debugDescFrom,
      guide: debugGuideFrom,
      author: debugAuthorFrom,
      publisher: debugPublisherFrom,
      rating: debugRatingFrom,
    }
  };
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

    const items = [];
    const seenId = new Set();

    $("a[href*='/books/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (!href.includes("/books/")) return;

      const link = href.startsWith("http") ? href : `https://ridibooks.com${href}`;
      const bookId = extractBookId(link);
      if (!bookId) return;

      if (seenId.has(bookId)) return;
      seenId.add(bookId);

      const title = pickTitle($, a, link);
      items.push({ title, link, bookId });
    });

    const top = items.slice(0, 12);

    const DETAIL_LIMIT = 8;
    const debugDetails = [];

    for (let i = 0; i < top.length && i < DETAIL_LIMIT; i++) {
      const it = top[i];
      const d = await fetchDetailAndExtract(it.link);

      if (d.titleFromDetail) it.title = d.titleFromDetail;

      it.coverUrl = d.coverUrl || undefined;
      it.isAdult = Boolean(d.isAdult);

      it.description = d.description || "";
      it.guide = d.guide || "";
      it.authorName = d.authorName || "";
      it.publisherName = d.publisherName || "";
      it.rating = d.rating == null ? undefined : d.rating;
      it.genre = d.genre || [];
      it.tags = d.tags || [];

      if (debug) {
        debugDetails.push({
          i,
          bookId: it.bookId,
          title: it.title,
          reason: d.reason,
          from: d.debug_from,
          hasCover: Boolean(d.coverUrl),
          isAdult: it.isAdult,
          descLen: (it.description || "").length,
          guideLen: (it.guide || "").length,
          hasAuthor: Boolean(it.authorName),
          hasPublisher: Boolean(it.publisherName),
          hasRating: it.rating != null,
          genreCount: (it.genre || []).length,
          tagsCount: (it.tags || []).length,
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
