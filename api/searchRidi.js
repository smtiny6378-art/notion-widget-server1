// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-03-v14-LIST_ONLY+fallback-OG-title+skip-badge-cover";

function absolutizeUrl(u) {
  if (!u) return "";
  const url = String(u).trim();
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return "https://ridibooks.com" + url;
  return url;
}

function extractBookId(link) {
  const m = String(link || "").match(/\/books\/(\d+)/);
  return m ? m[1] : null;
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
  t = t.replace(/\s*[-|｜]\s*최신권.*$/g, "").trim();
  t = t.replace(/\s*[-|｜]\s*독점.*$/g, "").trim();
  t = t.replace(/\s*[-|｜]\s*리디.*$/gi, "").trim();
  if (t.length > 120) t = t.slice(0, 120);
  return t;
}

function isPlausibleTitle(t) {
  const s = normalizeText(t);
  if (!s) return false;
  if (s.length < 2 || s.length > 140) return false;
  if (/검색|필터|정렬|더보기|바로가기|리디북스|RIDIBOOKS/i.test(s)) return false;
  return true;
}

// a 기준 title
function pickTitleFromAnchor($, a, link) {
  const alt = $(a).find("img").first().attr("alt");
  if (isPlausibleTitle(alt)) return cleanTitle(alt);

  const aria = $(a).attr("aria-label");
  if (isPlausibleTitle(aria)) return cleanTitle(aria);

  const text = normalizeText($(a).text());
  if (isPlausibleTitle(text)) return cleanTitle(text);

  const id = extractBookId(link);
  return id ? `RIDIBOOKS ${id}` : "RIDIBOOKS";
}

// 카드에서 cover 후보(뱃지 제외)
function pickCoverFromNearby($, a) {
  const $a = $(a);
  const $scope = $a.closest("li,article,section,div");
  const $card = ($scope && $scope.length) ? $scope : $a.parent();

  if (!$card || !$card.length) return "";

  const imgs = $card.find("img").toArray();
  const candidates = [];

  for (const el of imgs) {
    const $img = $(el);
    const src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      $img.attr("src") ||
      "";
    const u = absolutizeUrl(src);
    if (!u) continue;

    // ✅ 뱃지/스티커 이미지 제외
    if (u.includes("/badge/on_book_cover/")) continue;
    if (u.includes("badge_margin_")) continue;

    candidates.push(u);
  }

  // cover/thumbnail 느낌 우선
  const coverLike = candidates.find(u => /cover|thumbnail/i.test(u));
  return coverLike || candidates[0] || "";
}

// ✅ 아주 가벼운 OG 정보만 가져오기(제목/표지)
async function fetchOgLite(bookLink, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(bookLink, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "Referer": "https://ridibooks.com/",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });

    if (!r.ok) return { title: "", coverUrl: "" };

    const html = await r.text();
    const $ = cheerio.load(html);

    const ogTitle =
      $('meta[property="og:title"]').attr("content") ||
      $('meta[name="twitter:title"]').attr("content") ||
      "";

    const ogImage =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[property="og:image:secure_url"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('meta[property="twitter:image"]').attr("content") ||
      "";

    return {
      title: cleanTitle(ogTitle || ""),
      coverUrl: absolutizeUrl(ogImage || ""),
    };
  } catch {
    return { title: "", coverUrl: "" };
  } finally {
    clearTimeout(t);
  }
}

// 간단 동시성 제한 Promise Pool
async function mapWithLimit(arr, limit, mapper) {
  const out = new Array(arr.length);
  let i = 0;

  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const cur = i++;
      out[cur] = await mapper(arr[cur], cur);
    }
  });

  await Promise.all(workers);
  return out;
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

      const title = pickTitleFromAnchor($, a, link);
      const coverUrl = pickCoverFromNearby($, a);

      const isAdult = Boolean(coverUrl && String(coverUrl).includes("cover_adult.png"));

      items.push({
        title,
        link,
        bookId,
        coverUrl: coverUrl || undefined,
        isAdult,
      });
    });

    const top = items.slice(0, 12);

    // ✅ RIDIBOOKS fallback만 OG로 보강 (동시성 3)
    const needsFixIdx = [];
    for (let i = 0; i < top.length; i++) {
      if (/^RIDIBOOKS\b/i.test(top[i].title) || !isPlausibleTitle(top[i].title)) {
        needsFixIdx.push(i);
      }
      // coverUrl이 뱃지로 들어온 경우도 보강 대상으로
      if (top[i].coverUrl && String(top[i].coverUrl).includes("/badge/on_book_cover/")) {
        if (!needsFixIdx.includes(i)) needsFixIdx.push(i);
      }
    }

    const ogResults = await mapWithLimit(needsFixIdx, 3, async (idx) => {
      const it = top[idx];
      const og = await fetchOgLite(it.link);
      return { idx, og };
    });

    for (const { idx, og } of ogResults) {
      if (!og) continue;
      if (og.title && isPlausibleTitle(og.title)) top[idx].title = og.title;

      // coverUrl이 없거나 뱃지면 og:image로 교체
      const curCover = top[idx].coverUrl || "";
      const isBadge = curCover.includes("/badge/on_book_cover/") || curCover.includes("badge_margin_");
      if ((!curCover || isBadge) && og.coverUrl) {
        top[idx].coverUrl = og.coverUrl;
        top[idx].isAdult = Boolean(og.coverUrl.includes("cover_adult.png"));
      }
    }

    const ridifallbackCount = top.filter(x => /^RIDIBOOKS\b/i.test(x.title)).length;

    return res.status(200).json({
      ok: true,
      q,
      items: top,
      version: VERSION,
      ...(debug ? { debug: { foundCount: items.length, ridifallbackCount, fixedCount: needsFixIdx.length } } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e), version: VERSION });
  }
};
