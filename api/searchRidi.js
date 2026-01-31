// api/searchRidi.js
const cheerio = require("cheerio");

async function getFetch() {
  if (typeof fetch !== "undefined") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractBookId(link) {
  const m = String(link || "").match(/\/books\/(\d+)/);
  return m ? m[1] : null;
}

function absolutizeUrl(u) {
  if (!u) return "";
  const url = String(u).trim();
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return "https://ridibooks.com" + url;
  return url;
}

// 상세 페이지에서 og:image / twitter:image 뽑기
async function fetchCoverFromDetail(fetchFn, bookLink) {
  try {
    const r = await fetchFn(bookLink, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });

    if (!r.ok) return null;

    const html = await r.text();
    const $ = cheerio.load(html);

    const og =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('meta[property="twitter:image"]').attr("content");

    const coverUrl = absolutizeUrl(og);
    return coverUrl || null;
  } catch {
    return null;
  }
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

    // 1) 일단 작품 링크 + 제목만 최대한 안정적으로 수집
    const items = [];
    const seen = new Set();

    $("a[href*='/books/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const link = href.startsWith("http") ? href : `https://ridibooks.com${href}`;

      if (seen.has(link)) return;

      // 제목 우선순위: img alt > aria-label > text
      const alt = $(a).find("img").first().attr("alt");
      const aria = $(a).attr("aria-label");
      const text = $(a).text().replace(/\s+/g, " ").trim();

      const title = (alt && alt.trim()) || (aria && aria.trim()) || text;
      if (!title) return;
      if (title.length > 80) return;

      // 너무 빡세면 누락되니 느슨하게(원하면 여기 조정 가능)
      if (q.length >= 2 && !title.includes(q)) return;

      seen.add(link);
      items.push({ title, link });
    });

    // 상위 12개만
    const top = items.slice(0, 12);

    // 2) ✅ 상세페이지에서 coverUrl 채우기
    // 너무 느려질 수 있어서, 처음엔 6개만 상세 크롤링하고 나머지는 빈 값 유지(원하면 12개 전부도 가능)
    const DETAIL_LIMIT = 8; // 추천: 6~10
    const targets = top.slice(0, DETAIL_LIMIT);

    // 병렬로 가져오되, 서버 부담 줄이려고 약간 텀 줄 수도 있음(필요시)
    const covers = await Promise.all(
      targets.map(async (it, idx) => {
        // 가끔 차단/불안정 방지용 아주 짧은 텀 (선택)
        if (idx > 0) await sleep(80);
        return fetchCoverFromDetail(fetchFn, it.link);
      })
    );

    // coverUrl 붙이기
    for (let i = 0; i < targets.length; i++) {
      targets[i].coverUrl = covers[i] || undefined;
      // bookId도 같이 내려주면 프론트/추후 확장에 도움
      targets[i].bookId = extractBookId(targets[i].link) || undefined;
    }

    // DETAIL_LIMIT 바깥도 bookId는 넣어주기
    for (let i = DETAIL_LIMIT; i < top.length; i++) {
      top[i].bookId = extractBookId(top[i].link) || undefined;
    }

    return res.status(200).json({ ok: true, q, items: top });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
