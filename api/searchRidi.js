// api/searchRidi.js
// ✅ RIDI 검색: __NEXT_DATA__ 우선 + HTML fallback(여러 패턴) + 안전한 중복 제거
// - "검색 결과가 안 나옴" 이슈를 최대한 줄이기 위한 견고 버전

function absolutizeRidi(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (!s) return "";
  if (s.startsWith("http")) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return "https://ridibooks.com" + s;
  return s;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function fetchHtml(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://ridibooks.com/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  const text = await r.text();
  return { ok: r.ok, status: r.status, html: text };
}

function extractNextData(html) {
  // <script id="__NEXT_DATA__"> ... </script>
  const m = String(html || "").match(/<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m || !m[1]) return null;
  return safeJsonParse(m[1]);
}

function deepCollect(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  out.push(obj);
  if (Array.isArray(obj)) {
    for (const v of obj) deepCollect(v, out);
    return out;
  }
  for (const k of Object.keys(obj)) deepCollect(obj[k], out);
  return out;
}

function normTitle(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function extractBookIdFromLink(link) {
  const m = String(link || "").match(/\/books\/(\d+)/);
  return m ? m[1] : "";
}

function uniqByLink(items, limit = 24) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const link = absolutizeRidi(it.link);
    if (!link) continue;
    if (seen.has(link)) continue;
    seen.add(link);

    const bookId = it.bookId || extractBookIdFromLink(link);
    out.push({
      title: normTitle(it.title) || "제목 미확인",
      link,
      bookId,
      coverUrl: it.coverUrl || "",
      isAdult: Boolean(it.isAdult),
    });

    if (out.length >= limit) break;
  }
  return out;
}

/**
 * ✅ 1) NEXT_DATA 파싱
 * - 다양한 구조에 대비해서 pool 전체를 훑으면서
 *   title/link/cover/bookId 조합이 보이면 후보로 수집
 */
function parseFromNextData(nextData) {
  const pool = deepCollect(nextData, []);
  const candidates = [];

  for (const o of pool) {
    if (!o || typeof o !== "object") continue;

    // 후보 값들 (있을 수도/없을 수도)
    const title =
      (typeof o.title === "string" && o.title) ||
      (typeof o.bookTitle === "string" && o.bookTitle) ||
      (typeof o.name === "string" && o.name) ||
      "";

    const bookId =
      (typeof o.bookId === "string" && o.bookId.match(/^\d+$/) ? o.bookId : "") ||
      (typeof o.id === "number" ? String(o.id) : "") ||
      (typeof o.id === "string" && o.id.match(/^\d+$/) ? o.id : "");

    let link =
      (typeof o.link === "string" && o.link) ||
      (typeof o.url === "string" && o.url) ||
      "";

    let coverUrl =
      (typeof o.coverUrl === "string" && o.coverUrl) ||
      (typeof o.thumbnailUrl === "string" && o.thumbnailUrl) ||
      (typeof o.imageUrl === "string" && o.imageUrl) ||
      (typeof o.image === "string" && o.image) ||
      "";

    // link 보정
    if (!link && bookId) link = `https://ridibooks.com/books/${bookId}`;
    if (link) link = absolutizeRidi(link);

    // cover 보정
    if (coverUrl) coverUrl = absolutizeRidi(coverUrl);

    const looksLikeBook =
      (link && link.includes("ridibooks.com/books/")) || (bookId && String(bookId).length >= 6);

    if (!looksLikeBook) continue;

    const isAdult = Boolean(coverUrl && String(coverUrl).includes("cover_adult.png"));

    candidates.push({
      title,
      link,
      bookId,
      coverUrl,
      isAdult,
    });
  }

  // 책 링크가 있는 것만 우선
  const withBookLink = candidates.filter(x => x.link && x.link.includes("ridibooks.com/books/"));
  return uniqByLink(withBookLink.length ? withBookLink : candidates, 24);
}

/**
 * ✅ 2) HTML fallback
 * - /books/123 패턴을 여러 방식으로 긁고
 * - 주변 텍스트에서 title 힌트(있으면)도 가져옴
 */
function extractAround(html, index, radius = 700) {
  const s = String(html || "");
  const start = Math.max(0, index - radius);
  const end = Math.min(s.length, index + radius);
  return s.slice(start, end);
}

function htmlUnescape(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseFromHtmlFallback(html) {
  const items = [];
  const seen = new Set();

  // 패턴 1) href="/books/123"
  const re1 = /href="(\/books\/\d+)"/g;
  // 패턴 2) href="https://ridibooks.com/books/123"
  const re2 = /href="(https?:\/\/ridibooks\.com\/books\/\d+)"/g;
  // 패턴 3) data-* 속성에 /books/123가 박히는 케이스
  const re3 = /(\/books\/\d{6,})/g;

  function pushLink(rawLink, idx) {
    const link = absolutizeRidi(rawLink);
    if (!link || !link.includes("/books/")) return;
    if (seen.has(link)) return;
    seen.add(link);

    const around = extractAround(html, idx);

    // title 힌트: title="", aria-label="", alt="" 순서로 시도
    let title =
      (around.match(/title="([^"]+)"/) || [])[1] ||
      (around.match(/aria-label="([^"]+)"/) || [])[1] ||
      (around.match(/alt="([^"]+)"/) || [])[1] ||
      "";

    title = normTitle(htmlUnescape(title));

    items.push({
      title: title || "제목 미확인",
      link,
      bookId: extractBookIdFromLink(link),
      coverUrl: "",
      isAdult: false,
    });
  }

  let m;
  while ((m = re1.exec(html)) !== null) {
    pushLink(m[1], m.index);
    if (items.length >= 24) break;
  }
  if (items.length < 6) {
    while ((m = re2.exec(html)) !== null) {
      pushLink(m[1], m.index);
      if (items.length >= 24) break;
    }
  }
  if (items.length < 6) {
    // 마지막 보험: 문서 전체에서 /books/숫자 를 긁음
    while ((m = re3.exec(html)) !== null) {
      pushLink(m[1], m.index);
      if (items.length >= 24) break;
    }
  }

  return uniqByLink(items, 24);
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const q = String(req.query?.q || "").trim();
    const debug = String(req.query?.debug || "") === "1";
    if (!q) return res.status(400).json({ ok: false, error: "q is required" });

    const url = `https://ridibooks.com/search?q=${encodeURIComponent(q)}`;
    const fetched = await fetchHtml(url);

    // RIDI가 봇 차단/리다이렉트하면 결과가 비게 됨 → debug로 status/html 길이 확인 가능
    const nextData = extractNextData(fetched.html);

    let items = [];
    let source = "empty";

    if (nextData) {
      items = parseFromNextData(nextData);
      source = items.length ? "next_data" : "next_data_empty";
    }

    if (!items.length) {
      items = parseFromHtmlFallback(fetched.html);
      source = items.length ? "html_fallback" : source;
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      q,
      items,
      source,
      ...(debug ? { debug: { status: fetched.status, htmlLen: fetched.html.length, hasNextData: Boolean(nextData) } } : {}),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      stack: e?.stack || null,
    });
  }
};
