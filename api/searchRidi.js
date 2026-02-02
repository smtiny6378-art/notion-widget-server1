// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-03-v11-LIST_ONLY-fast";

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
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
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

  // 흔한 마케팅 꼬리 제거
  t = t.replace(/\s*[-|｜]\s*최신권.*$/g, "").trim();
  t = t.replace(/\s*[-|｜]\s*독점.*$/g, "").trim();
  t = t.replace(/\s*[-|｜]\s*리디.*$/gi, "").trim();

  if (t.length > 120) t = t.slice(0, 120);
  return t;
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

// 리스트 단계에서 "가능하면" 표지 얻기(빠르게)
// - og:image / next_data / img src 등 가벼운 후보만
function pickCoverFromAnchor($, a) {
  // 1) a 안의 img src/data-src
  const img = $(a).find("img").first();
  const src =
    img.attr("src") ||
    img.attr("data-src") ||
    img.attr("data-original") ||
    "";
  if (src) return absolutizeUrl(src);

  // 2) 주변에 있는 img(가끔 구조가 다름) - parent 범위에서 한번 더
  const parent = $(a).parent();
  if (parent && parent.length) {
    const img2 = parent.find("img").first();
    const src2 =
      img2.attr("src") ||
      img2.attr("data-src") ||
      img2.attr("data-original") ||
      "";
    if (src2) return absolutizeUrl(src2);
  }

  return "";
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

    // next_data가 있으면 거기서도 cover 후보를 조금 더 잡을 수 있음(있을 때만)
    const nextText = $("#__NEXT_DATA__").first().text();
    const next = nextText ? safeJsonParse(nextText) : null;

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

      // 리스트에서 가능한 cover를 뽑기 (없으면 빈 값)
      let coverUrl = pickCoverFromAnchor($, a);

      // next_data에서 더 찾을 수 있으면(있을 때만) 보강
      if (!coverUrl && next) {
        // next_data 내부에 coverUrl 계열이 있는 경우가 있어 가볍게 탐색
        // (정확히 bookId 매칭은 구조마다 달라서 여기선 '있으면' 정도만)
        const cover = findInJson(next, ["coverUrl", "thumbnailUrl", "thumbnail", "imageUrl", "image"]);
        if (typeof cover === "string" && cover.trim()) coverUrl = absolutizeUrl(cover);
      }

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

    return res.status(200).json({
      ok: true,
      q,
      items: top,
      version: VERSION,
      ...(debug ? { debug: { foundCount: items.length } } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e), version: VERSION });
  }
};
