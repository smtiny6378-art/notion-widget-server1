// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-02-v9-dom-description+romanceGuide+title";

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

// JSON 트리에서 특정 키 후보들을 찾아 첫 값 반환
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

// ✅ 검색 결과에서 제목 뽑기(없으면 bookId fallback)
function pickTitle($, a, link) {
  const alt = $(a).find("img").first().attr("alt");
  const aria = $(a).attr("aria-label");
  const text = $(a).text().replace(/\s+/g, " ").trim();

  let title = (alt && alt.trim()) || (aria && aria.trim()) || text || "";
  title = title.replace(/\s+/g, " ").trim();

  if (title.length > 120) title = title.slice(0, 120);

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

/**
 * ✅ DOM에서 섹션 추출(작품 소개/로맨스 가이드)
 * - "작품 소개" 같은 제목 텍스트를 찾고,
 * - 그 주변(부모/형제/다음 요소)에서 긴 텍스트를 긁어온다.
 */
function extractSectionByHeading($, headingCandidates) {
  const candidates = headingCandidates.map(h => normalizeText(h));
  const all = $("body *").toArray();

  // 1) 제목 후보를 포함하는 "짧은" 요소를 찾는다
  let headingEl = null;
  for (const el of all) {
    const t = normalizeText($(el).text());
    if (!t) continue;
    if (t.length > 30) continue; // 제목은 보통 짧음
    if (candidates.some(h => t === h || t.includes(h))) {
      headingEl = el;
      break;
    }
  }
  if (!headingEl) return "";

  const $h = $(headingEl);

  // 2) 같은 섹션 안에서 "긴 텍스트" 후보를 찾는다
  //    - heading의 부모/조부모, 또는 다음 형제들 중 텍스트가 긴 것을 선택
  const scopes = [];
  scopes.push($h.parent());
  scopes.push($h.parent().parent());
  scopes.push($h.parent().parent().parent());

  // heading 뒤에 오는 형제들
  const sibs = $h.parent().children().toArray();
  const idx = sibs.indexOf(headingEl);
  if (idx >= 0) {
    for (let i = idx + 1; i < Math.min(sibs.length, idx + 6); i++) {
      scopes.push($(sibs[i]));
    }
  }
  // heading 자체 다음 형제들
  let next = $h.next();
  let steps = 0;
  while (next && next.length && steps < 6) {
    scopes.push(next);
    next = next.next();
    steps++;
  }

  let best = "";
  for (const $scope of scopes) {
    if (!$scope || !$scope.length) continue;
    const txt = cleanSectionText($scope.text());
    if (!txt) continue;

    // 섹션 제목 문구가 섞여 있을 수 있으니 제거
    let cleaned = txt;
    for (const h of candidates) cleaned = cleaned.replace(h, "").trim();

    // "작품 소개:" 형태가 있으면 그 뒤를 우선
    cleaned = cleaned.replace(/^[:：\-–—]\s*/g, "");

    if (cleaned.length > best.length) best = cleaned;
  }

  // 너무 짧으면 실패로 간주
  if (best.length < 80) return "";
  // 너무 길면 적당히 컷(노션은 더 길어도 되지만 서버 응답 과대 방지)
  return best.slice(0, 20000);
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
      debug_from: { title: "none", description: "none", guide: "none" },
    };
  }

  const html = await r.text();
  const $ = cheerio.load(html);

  // --- title ---
  let titleFromDetail = "";
  const ogTitle =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    "";
  if (ogTitle) titleFromDetail = normalizeText(ogTitle);

  // ld+json name
  const ldTxt = $('script[type="application/ld+json"]').first().text();
  const ldObj = ldTxt ? safeJsonParse(ldTxt) : null;
  if (!titleFromDetail && ldObj && typeof ldObj === "object" && ldObj.name) {
    titleFromDetail = normalizeText(ldObj.name);
  }

  // __NEXT_DATA__ title 후보
  const nextText = $("#__NEXT_DATA__").first().text();
  const next = nextText ? safeJsonParse(nextText) : null;
  if (!titleFromDetail && next) {
    const t = findInJson(next, ["title", "bookTitle", "productTitle", "name"]);
    if (typeof t === "string" && t.trim()) titleFromDetail = normalizeText(t);
  }

  let debugTitleFrom = titleFromDetail ? "og_or_ld_or_next" : "none";

  // --- cover ---
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
    const img =
      (ldObj && typeof ldObj === "object" && (ldObj.image || (ldObj.mainEntity && ldObj.mainEntity.image))) || null;
    if (typeof img === "string" && img) {
      coverUrl = absolutizeUrl(img);
      reason = "ld_json";
    }
  }

  const isAdult = Boolean(coverUrl && String(coverUrl).includes("cover_adult.png"));

  // --- fields ---
  let description = "";
  let guide = "";
  let authorName = "";
  let publisherName = "";
  let rating = null;
  let genre = [];
  let tags = [];

  let debugDescFrom = "none";
  let debugGuideFrom = "none";

  // 1) next_data 기반(있으면 가장 정확할 때가 많음)
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

  // 2) DOM에서 "작품 소개" 섹션 추출 (og 요약보다 우선)
  const domDesc = extractSectionByHeading($, ["작품 소개", "작품소개", "책 소개", "줄거리", "소개"]);
  if (domDesc) {
    description = domDesc;
    debugDescFrom = "dom_section";
  }

  // 3) DOM에서 "로맨스 가이드" 섹션 추출
  const domGuide = extractSectionByHeading($, ["로맨스 가이드", "로맨스가이드", "가이드"]);
  if (domGuide) {
    guide = domGuide;
    debugGuideFrom = "dom_section";
  }

  // 4) og:description fallback(대부분 ... 로 잘림)
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

  // 5) ld+json keywords 섞기
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
    debug_from: { title: debugTitleFrom, description: debugDescFrom, guide: debugGuideFrom }
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

    // 검색 페이지에서 /books/ 링크 모으기(중복은 bookId로 제거)
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

      // ✅ 상세에서 제목 얻으면 덮어쓰기 (RIDIBOOKS xxx 방지)
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
