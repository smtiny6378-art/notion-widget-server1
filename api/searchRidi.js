// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-01-v5-ui+notion";

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

// JSON 트리에서 특정 키 후보들을 찾아 첫 번째 문자열/배열/객체 값을 가져오는 도우미
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
      .slice(0, 8);
  }
  if (typeof tags === "string") {
    return tags
      .split(/[,#]/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  return [];
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
    return { coverUrl: null, isAdult: false, meta: "", tags: [], reason: `detail status ${r.status}` };
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
    const ld = $('script[type="application/ld+json"]').first().text();
    const j = ld ? safeJsonParse(ld) : null;
    const img =
      (j && typeof j === "object" && (j.image || (j.mainEntity && j.mainEntity.image))) || null;
    if (typeof img === "string" && img) {
      coverUrl = absolutizeUrl(img);
      reason = "ld_json";
    }
  }

  // isAdult: 성인 대체 표지로 판별(정상 범위)
  const isAdult = Boolean(coverUrl && String(coverUrl).includes("cover_adult.png"));

  // meta/tags: 가능한 범위에서 NEXT_DATA / og:description / ld+json에서 추출
  let meta = "";
  let tags = [];

  // og:description을 meta로 쓰기(없으면 빈 문자열)
  const ogDesc =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content") ||
    "";
  if (ogDesc) meta = ogDesc.replace(/\s+/g, " ").trim();

  // NEXT_DATA에서 키워드/태그 후보 찾기
  if (next) {
    const keywordVal = findInJson(next, ["keywords", "keyword", "tags", "tagList", "hashTags", "hashtags"]);
    tags = normalizeTags(keywordVal);
  }

  // ld+json keywords가 있으면 섞기
  const ld = $('script[type="application/ld+json"]').first().text();
  const j = ld ? safeJsonParse(ld) : null;
  if (j && typeof j === "object" && j.keywords) {
    const ldTags = normalizeTags(j.keywords);
    const merged = [...tags, ...ldTags];
    tags = Array.from(new Set(merged)).slice(0, 8);
  }

  return { coverUrl, isAdult, meta, tags, reason };
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

    // 검색 페이지에서 제목/링크 수집
    const items = [];
    const seen = new Set();

    $("a[href*='/books/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const link = href.startsWith("http") ? href : `https://ridibooks.com${href}`;
      if (seen.has(link)) return;

      const alt = $(a).find("img").first().attr("alt");
      const aria = $(a).attr("aria-label");
      const text = $(a).text().replace(/\s+/g, " ").trim();
      const title = (alt && alt.trim()) || (aria && aria.trim()) || text;

      if (!title) return;
      if (title.length > 80) return;
      if (q.length >= 2 && !title.includes(q)) return;

      seen.add(link);
      items.push({ title, link, bookId: extractBookId(link) || undefined });
    });

    const top = items.slice(0, 12);

    // 상세 페이지에서 cover/meta/tags 채우기 (상위 8개)
    const DETAIL_LIMIT = 8;
    const debugDetails = [];

    for (let i = 0; i < top.length && i < DETAIL_LIMIT; i++) {
      const it = top[i];
      const d = await fetchDetailAndExtract(it.link);
      it.coverUrl = d.coverUrl || undefined;
      it.isAdult = Boolean(d.isAdult);
      it.meta = d.meta || "";
      it.tags = d.tags || [];
      if (debug) debugDetails.push({ i, title: it.title, reason: d.reason, hasCover: Boolean(d.coverUrl), isAdult: it.isAdult });
    }

    return res.status(200).json({
      ok: true,
      q,
      items: top,
      version: VERSION,
      ...(debug ? { debug: { detail: debugDetails } } : {})
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e), version: VERSION });
  }
};
