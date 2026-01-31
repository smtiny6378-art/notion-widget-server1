// api/searchRidi.js
const cheerio = require("cheerio");

const VERSION = "searchRidi-2026-02-01-v4-node24";

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

// 상세 페이지에서 coverUrl 뽑기 (NEXT_DATA → og:image → json-ld image)
async function fetchCoverFromDetail(bookLink) {
  const r = await fetch(bookLink, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "Referer": "https://ridibooks.com/",
    },
    redirect: "follow",
  });

  if (!r.ok) return { coverUrl: null, reason: `detail status ${r.status}` };

  const html = await r.text();
  const $ = cheerio.load(html);

  // 1) NEXT_DATA
  const nextText = $("#__NEXT_DATA__").first().text();
  if (nextText) {
    const next = safeJsonParse(nextText);
    if (next) {
      const keys = ["coverUrl", "thumbnailUrl", "thumbnail", "imageUrl", "image", "cover"];
      let found = null;

      const stack = [next];
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
            if (!found && keys.includes(k) && typeof v === "string") {
              const abs = absolutizeUrl(v);
              if (abs) found = abs;
            }
            stack.push(v);
          }
        }
      }

      if (found) return { coverUrl: found, reason: "next_data" };
    }
  }

  // 2) og:image
  const og =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[property="og:image:secure_url"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $('meta[property="twitter:image"]').attr("content");

  if (og) return { coverUrl: absolutizeUrl(og), reason: "og_meta" };

  // 3) JSON-LD image
  const ld = $('script[type="application/ld+json"]').first().text();
  if (ld) {
    const j = safeJsonParse(ld);
    const img =
      (j && typeof j === "object" && (j.image || (j.mainEntity && j.mainEntity.image))) || null;
    if (typeof img === "string" && img) {
      return { coverUrl: absolutizeUrl(img), reason: "ld_json" };
    }
  }

  return { coverUrl: null, reason: "no_cover_found" };
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
    // 1) 검색 페이지에서 title/link 수집
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

    // 2) 상세 페이지에서 coverUrl 채우기 (상위 8개)
    const DETAIL_LIMIT = 8;
    const debugDetails = [];

    for (let i = 0; i < top.length && i < DETAIL_LIMIT; i++) {
      const it = top[i];
      const { coverUrl, reason } = await fetchCoverFromDetail(it.link);
      it.coverUrl = coverUrl || undefined;
      if (debug) debugDetails.push({ i, title: it.title, reason, hasCover: Boolean(coverUrl) });
    }

    const payload = { ok: true, q, items: top, version: VERSION };
    if (debug) payload.debug = { detail: debugDetails };

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e), version: VERSION });
  }
};
