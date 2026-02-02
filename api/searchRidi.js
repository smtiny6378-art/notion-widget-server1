// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-03-v12-LIST_ONLY+better-title-from-nextdata";

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

// "책 제목" 느낌만 남기기(너무 이상한 문자열 제거)
function isPlausibleTitle(t) {
  if (!t) return false;
  const s = normalizeText(t);
  if (!s) return false;
  if (s.length < 2) return false;
  if (s.length > 140) return false;
  // UI 문구/노이즈 제거
  if (/검색|필터|정렬|더보기|바로가기|리디북스|RIDIBOOKS/i.test(s)) return false;
  return true;
}

// 검색 결과에서 title 뽑기(강화)
function pickTitle($, a, link) {
  // 1) img alt
  const alt = $(a).find("img").first().attr("alt");
  if (isPlausibleTitle(alt)) return cleanTitle(alt);

  // 2) aria-label
  const aria = $(a).attr("aria-label");
  if (isPlausibleTitle(aria)) return cleanTitle(aria);

  // 3) a 내부 텍스트
  const text = normalizeText($(a).text());
  if (isPlausibleTitle(text)) return cleanTitle(text);

  // 4) 주변(부모)에서 제목 후보 찾기
  const parent = $(a).parent();
  if (parent && parent.length) {
    const t = normalizeText(parent.text());
    // 부모 텍스트가 너무 길면(여러 작품 섞임) 제외
    if (isPlausibleTitle(t) && t.length <= 80) return cleanTitle(t);
  }

  // 5) 실패 시 fallback
  const id = extractBookId(link);
  return id ? `RIDIBOOKS ${id}` : "RIDIBOOKS";
}

// 리스트 단계에서 "가능하면" 표지 얻기
function pickCoverFromAnchor($, a) {
  const img = $(a).find("img").first();
  const src =
    img.attr("src") ||
    img.attr("data-src") ||
    img.attr("data-original") ||
    "";
  if (src) return absolutizeUrl(src);

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

// __NEXT_DATA__에서 bookId -> title 매핑 만들기 (핵심)
function buildTitleMapFromNext(next) {
  const map = Object.create(null);
  if (!next || typeof next !== "object") return map;

  const stack = [next];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }

    if (typeof cur === "object") {
      // bookId/title 같이 있는 흔한 패턴을 최대한 잡기
      const id = cur.bookId || cur.id || cur.productId || cur.workId;
      const title = cur.title || cur.name || cur.bookTitle || cur.productTitle;

      const idStr = id != null ? String(id).replace(/[^\d]/g, "") : "";
      const t = typeof title === "string" ? cleanTitle(title) : "";

      if (idStr && isPlausibleTitle(t) && !map[idStr]) {
        map[idStr] = t;
      }

      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
  }

  return map;
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

    const nextText = $("#__NEXT_DATA__").first().text();
    const next = nextText ? safeJsonParse(nextText) : null;

    // ✅ bookId -> title 맵 (DOM에서 못 뽑아도 여기서 보강)
    const titleMap = buildTitleMapFromNext(next);

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

      let title = pickTitle($, a, link);

      // ✅ RIDIBOOKS fallback로 떨어졌으면 next_data title로 치환
      if (/^RIDIBOOKS\b/i.test(title) && titleMap[bookId]) {
        title = titleMap[bookId];
      } else if (!isPlausibleTitle(title) && titleMap[bookId]) {
        title = titleMap[bookId];
      }

      let coverUrl = pickCoverFromAnchor($, a);

      // next_data에서 cover가 있으면 보강(있을 때만)
      // (정확히 bookId 매칭이 어려워서, cover가 전혀 없을 때만 한 번 더 시도)
      if (!coverUrl && next) {
        // coverUrl 계열이 존재할 수 있어 한 번만 탐색
        // (여기서도 bookId 매칭 로직을 더 세밀하게 만들 수 있지만, 일단 title 문제 해결이 핵심이라 최소화)
        const stack = [next];
        while (stack.length && !coverUrl) {
          const cur = stack.pop();
          if (!cur) continue;
          if (Array.isArray(cur)) {
            for (const v of cur) stack.push(v);
            continue;
          }
          if (typeof cur === "object") {
            // bookId가 같은 노드를 찾으면 그 근처에서 cover 후보
            const id = cur.bookId || cur.id || cur.productId || cur.workId;
            const idStr = id != null ? String(id).replace(/[^\d]/g, "") : "";
            if (idStr === bookId) {
              const c = cur.coverUrl || cur.thumbnailUrl || cur.imageUrl || cur.image || cur.thumbnail;
              if (typeof c === "string" && c.trim()) coverUrl = absolutizeUrl(c);
              break;
            }
            for (const k of Object.keys(cur)) stack.push(cur[k]);
          }
        }
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

    // debug용: RIDIBOOKS fallback 개수
    const ridifallbackCount = top.filter(x => /^RIDIBOOKS\b/i.test(x.title)).length;

    return res.status(200).json({
      ok: true,
      q,
      items: top,
      version: VERSION,
      ...(debug ? { debug: { foundCount: items.length, ridifallbackCount } } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e), version: VERSION });
  }
};
