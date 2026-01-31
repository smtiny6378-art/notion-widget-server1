// api/searchRidi.js
const cheerio = require("cheerio");

// Node 버전에 따라 fetch가 없을 수 있어서 안전 처리
async function getFetch() {
  if (typeof fetch !== "undefined") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

// JSON 트리에서 "book-like" 객체를 찾아서 최대한 뽑아내기
function extractBookCandidatesFromJson(root) {
  const out = [];
  const seen = new Set();

  function walk(node) {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }

    if (!isObject(node)) return;

    // 흔히 보이는 키 조합(정확히 일치하지 않아도 후보로)
    const title =
      node.title ||
      node.name ||
      node.bookTitle ||
      node.workTitle ||
      (node.book && node.book.title);

    const id =
      node.bookId ||
      node.id ||
      node.workId ||
      (node.book && (node.book.id || node.book.bookId));

    // 썸네일/커버 후보 키들
    const coverUrl =
      node.coverUrl ||
      node.thumbnailUrl ||
      node.thumbnail ||
      node.imageUrl ||
      node.image ||
      node.cover ||
      (node.book && (node.book.coverUrl || node.book.thumbnailUrl || node.book.thumbnail));

    // 성인/19 후보 키들
    const isAdult =
      node.isAdult ||
      node.adult ||
      node.adultOnly ||
      node.is19 ||
      (node.book && (node.book.isAdult || node.book.adultOnly));

    // 메타(작가/장르 등) 후보
    const meta =
      node.meta ||
      node.category ||
      node.genre ||
      node.publisher ||
      node.author ||
      (node.book && (node.book.author || node.book.publisher));

    // "리디 검색 결과"에서 book-like로 보이면 후보로 수집
    if (typeof title === "string" && title.trim().length > 0) {
      const key = `${String(id || "")}::${title.trim()}::${String(coverUrl || "")}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          id: id ? String(id) : undefined,
          title: title.trim(),
          coverUrl: coverUrl ? String(coverUrl) : undefined,
          isAdult: Boolean(isAdult),
          meta: meta ? String(meta) : undefined,
        });
      }
    }

    // 계속 탐색
    for (const k of Object.keys(node)) walk(node[k]);
  }

  walk(root);
  return out;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = (req.query?.q || "").toString().trim();
  if (!q) return res.status(400).json({ ok: false, error: "q is required" });

  try {
    const fetchFn = await getFetch();

    // 리디 검색 URL
    const url = `https://ridibooks.com/search?q=${encodeURIComponent(q)}`;

    const r = await fetchFn(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });

    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `search fetch failed: ${r.status}` });
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    let items = [];

    // -------------------------------------------------------
    // 1) ✅ Next.js __NEXT_DATA__가 있으면 그걸로 먼저 파싱
    // -------------------------------------------------------
    const nextDataText = $("#__NEXT_DATA__").first().text();
    const nextData = nextDataText ? safeJsonParse(nextDataText) : null;

    if (nextData) {
      const candidates = extractBookCandidatesFromJson(nextData);

      // candidates는 너무 많을 수 있어서, "검색어 포함" 기준으로 1차 필터
      // (완전 일치만 강요하면 또 놓치니까 느슨하게)
      const loweredQ = q.toLowerCase();
      const filtered = candidates.filter(x => (x.title || "").toLowerCase().includes(loweredQ));

      // coverUrl 없는 애들은 뒤로 보내고, title 길이 너무 긴 건 제외
      const cleaned = (filtered.length ? filtered : candidates)
        .filter(x => x.title && x.title.length <= 80)
        .sort((a, b) => {
          const ac = a.coverUrl ? 1 : 0;
          const bc = b.coverUrl ? 1 : 0;
          return bc - ac; // coverUrl 있는 것을 우선
        });

      // link 만들기(가능하면 id 기반)
      items = cleaned.slice(0, 12).map(x => {
        const id = x.id;
        const link = id
          ? `https://ridibooks.com/books/${id}`
          : undefined;

        return {
          title: x.title,
          link,                 // id가 없으면 아래 fallback에서 채움
          coverUrl: x.coverUrl,
          meta: x.meta,
          isAdult: x.isAdult,
          id,
        };
      });
    }

    // -------------------------------------------------------
    // 2) ✅ __NEXT_DATA__가 없거나 items가 비면 기존 방식 fallback
    //    (title/link는 최소 보장)
    // -------------------------------------------------------
    if (!items || items.length === 0) {
      const seen = new Set();

      $("a").each((_, a) => {
        const href = $(a).attr("href") || "";
        const text = $(a).text().trim();
        if (!href || !text) return;

        if (text.length > 60) return;

        const link = href.startsWith("http") ? href : `https://ridibooks.com${href}`;
        if (seen.has(link)) return;

        // 너무 빡세게 includes로 걸러버리면 풀네임 문제 생겨서 완화
        // (검색어가 2글자 이상일 때만 느슨하게 포함 체크)
        if (q.length >= 2 && !text.includes(q)) return;

        seen.add(link);
        items.push({ title: text, link });
      });

      items = items.slice(0, 12);
    }

    // -------------------------------------------------------
    // 3) ✅ 마지막 정리: link가 없는 항목이 있으면 fallback로 채우기
    // -------------------------------------------------------
    items = (items || []).map(it => {
      const title = it.title || "";
      const id = it.id;

      const link =
        it.link ||
        (id ? `https://ridibooks.com/books/${id}` : undefined) ||
        ""; // 최소 빈 문자열이라도

      return {
        title,
        link,
        coverUrl: it.coverUrl, // 없을 수 있음(그럼 프론트에서 placeholder)
        meta: it.meta,
        isAdult: Boolean(it.isAdult),
      };
    });

    return res.status(200).json({ ok: true, q, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
