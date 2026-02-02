// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-03-v13-LIST_ONLY+robust-title+skip-badge-cover";

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

  // 흔한 마케팅 꼬리 제거
  t = t.replace(/\s*[-|｜]\s*최신권.*$/g, "").trim();
  t = t.replace(/\s*[-|｜]\s*독점.*$/g, "").trim();
  t = t.replace(/\s*[-|｜]\s*리디.*$/gi, "").trim();

  if (t.length > 120) t = t.slice(0, 120);
  return t;
}

function isPlausibleTitle(t) {
  const s = normalizeText(t);
  if (!s) return false;
  if (s.length < 2) return false;
  if (s.length > 140) return false;

  // UI/노이즈
  if (/검색|필터|정렬|더보기|바로가기|리디북스|RIDIBOOKS/i.test(s)) return false;

  return true;
}

// 카드 컨테이너 추정: a의 가까운 조상에서 "카드"처럼 보이는 영역 찾기
function getCardScope($, a) {
  // 너무 큰 body까지 올라가면 안 되니 제한
  const $a = $(a);

  // 우선적으로 흔한 컨테이너 태그 후보
  const selectors = [
    "li",
    "article",
    "section",
    "div",
  ];

  // a의 부모들 중에서 "텍스트가 적당히(너무 길지 않게) 포함"되는 첫 컨테이너를 카드로
  for (const sel of selectors) {
    const $c = $a.closest(sel);
    if ($c && $c.length) {
      const t = normalizeText($c.text());
      // 카드 하나면 제목+작가 정도로 보통 10~120자 사이가 많음
      if (t && t.length >= 2 && t.length <= 220) return $c;
    }
  }

  // 차선: 부모 3단계까지
  let $p = $a.parent();
  for (let i = 0; i < 3; i++) {
    if ($p && $p.length) {
      const t = normalizeText($p.text());
      if (t && t.length >= 2 && t.length <= 220) return $p;
      $p = $p.parent();
    }
  }

  return null;
}

// 카드에서 제목 후보 찾기(우선순위 기반)
function pickTitleFromCard($, $card) {
  if (!$card || !$card.length) return "";

  // 1) title/aria-label 속성
  const attrCandidates = [];
  $card.find("[title], [aria-label]").each((_, el) => {
    const t1 = $(el).attr("title");
    const t2 = $(el).attr("aria-label");
    if (t1) attrCandidates.push(t1);
    if (t2) attrCandidates.push(t2);
  });

  for (const v of attrCandidates) {
    const t = cleanTitle(v);
    if (isPlausibleTitle(t)) return t;
  }

  // 2) class에 title/name 포함된 요소 텍스트
  const classTitleEls = $card.find("[class*='title'], [class*='Title'], [class*='name'], [class*='Name']");
  if (classTitleEls && classTitleEls.length) {
    for (const el of classTitleEls.toArray()) {
      const t = cleanTitle($(el).text());
      if (isPlausibleTitle(t)) return t;
    }
  }

  // 3) heading 태그
  const headings = $card.find("h1,h2,h3,h4");
  if (headings && headings.length) {
    for (const el of headings.toArray()) {
      const t = cleanTitle($(el).text());
      if (isPlausibleTitle(t)) return t;
    }
  }

  // 4) 카드 전체 텍스트에서 첫 줄(짧은 문자열) 추정
  const full = normalizeText($card.text());
  if (full) {
    // 줄바꿈이 없어도, 점/구분자 기준으로 잘라보기
    const parts = full.split(/[\n·•|｜]/g).map(s => cleanTitle(s)).filter(Boolean);
    for (const p of parts) {
      if (isPlausibleTitle(p) && p.length <= 80) return p;
    }
  }

  return "";
}

// a 자체에서 제목 뽑기(기본)
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

// 뱃지/아이콘 말고 "표지"에 가까운 이미지 선택
function pickCoverFromCard($, $card) {
  if (!$card || !$card.length) return "";

  const imgs = $card.find("img").toArray();
  const urls = [];

  for (const el of imgs) {
    const $img = $(el);
    const src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      $img.attr("src") ||
      "";

    const u = absolutizeUrl(src);
    if (!u) continue;

    // ✅ 뱃지 이미지는 제외
    if (u.includes("/badge/on_book_cover/")) continue;
    if (u.includes("badge_margin_")) continue;

    urls.push(u);
  }

  // cover 키워드 들어간 걸 우선
  const coverLike = urls.find(u => /cover|thumbnail/i.test(u));
  if (coverLike) return coverLike;

  // 아니면 첫 번째
  return urls[0] || "";
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

      // 1) a 기준 기본 타이틀
      let title = pickTitleFromAnchor($, a, link);

      // 2) 카드 컨테이너에서 타이틀 보강
      const $card = getCardScope($, a);
      const cardTitle = pickTitleFromCard($, $card);
      if (isPlausibleTitle(cardTitle)) {
        // a에서 RIDIBOOKS로 떨어졌거나, cardTitle이 더 그럴듯하면 교체
        if (/^RIDIBOOKS\b/i.test(title) || !isPlausibleTitle(title)) {
          title = cardTitle;
        } else {
          // 둘 다 그럴듯하면 더 짧고 "책 제목처럼" 보이는 쪽(보통 cardTitle)이 낫다
          if (cardTitle.length <= title.length) title = cardTitle;
        }
      }

      // cover도 카드 기준으로 뽑기(뱃지 제외)
      const coverUrl = pickCoverFromCard($, $card);

      const isAdult = Boolean(coverUrl && String(coverUrl).includes("cover_adult.png"));

      items.push({
        title: title || `RIDIBOOKS ${bookId}`,
        link,
        bookId,
        coverUrl: coverUrl || undefined,
        isAdult,
      });
    });

    const top = items.slice(0, 12);

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
