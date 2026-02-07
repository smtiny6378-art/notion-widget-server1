// api/searchRidi.js
// ✅ RIDI 검색 (정밀 파서): __NEXT_DATA__의 "검색 결과 리스트" 경로만 사용
// - 무작위 이름/태그 섞이는 문제 해결

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
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  const html = await r.text();
  return html;
}

function extractNextData(html) {
  const m = String(html || "").match(/<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m || !m[1]) return null;
  return safeJsonParse(m[1]);
}

// __NEXT_DATA__ 안에서 "books" 배열처럼 보이는 리스트만 추적
function findSearchResultLists(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;

  if (Array.isArray(obj)) {
    // 배열 안의 객체가 "bookId/title/link" 조합이면 검색 결과일 가능성 ↑
    const looksLikeBookList =
      obj.length &&
      obj.every(x => x && typeof x === "object") &&
      obj.some(x => x.bookId || x.id) &&
      obj.some(x => x.title || x.name);

    if (looksLikeBookList) out.push(obj);

    for (const v of obj) findSearchResultLists(v, out);
    return out;
  }

  for (const k of Object.keys(obj)) {
    findSearchResultLists(obj[k], out);
  }

  return out;
}

function normalizeTitle(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function extractFromList(list) {
  const items = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;

    const bookId =
      (typeof o.bookId === "string" && o.bookId) ||
      (typeof o.id === "number" ? String(o.id) : "") ||
      (typeof o.id === "string" && o.id.match(/^\d+$/) ? o.id : "");

    let link =
      (typeof o.link === "string" && o.link) ||
      (typeof o.url === "string" && o.url) ||
      "";

    if (!link && bookId) link = `https://ridibooks.com/books/${bookId}`;
    link = absolutizeRidi(link);

    const title =
      normalizeTitle(o.title || o.bookTitle || o.name || "") || "제목 미확인";

    const coverUrl =
      absolutizeRidi(o.coverUrl || o.thumbnailUrl || o.imageUrl || "");

    if (!link || !link.includes("/books/")) continue;

    items.push({
      title,
      link,
      bookId,
      coverUrl,
      isAdult: Boolean(coverUrl && coverUrl.includes("cover_adult.png")),
    });
  }
  return items;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const q = String(req.query?.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q is required" });

    const url = `https://ridibooks.com/search?q=${encodeURIComponent(q)}`;
    const html = await fetchHtml(url);

    const nextData = extractNextData(html);
    if (!nextData) {
      return res.status(200).json({ ok: true, q, items: [], source: "no_next_data" });
    }

    const lists = findSearchResultLists(nextData, []);
    let best = [];

    for (const list of lists) {
      const items = extractFromList(list);
      if (items.length > best.length) best = items;
    }

    // 상위 20개만
    best = best.slice(0, 20);

    return res.status(200).json({
      ok: true,
      q,
      items: best,
      source: "next_data_search_lists",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
};
