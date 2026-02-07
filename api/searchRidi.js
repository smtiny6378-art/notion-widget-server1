// api/searchRidi.js
// ✅ No external dependencies, safe RIDI search (HTML meta scraping fallback)

function extractBetween(html, re) {
  const m = String(html || "").match(re);
  return m && m[1] ? m[1].trim() : "";
}

function absolutizeRidi(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (!s) return "";
  if (s.startsWith("http")) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return "https://ridibooks.com" + s;
  return s;
}

async function fetchHtml(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://ridibooks.com/",
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  return await r.text();
}

function parseRidiSearchResults(html) {
  const items = [];

  // RIDI 검색 결과 카드 링크 대충 파싱 (DOM 파서 없이 문자열 정규식)
  const linkRe = /href="(\/books\/\d+)"/g;
  let m;
  const seen = new Set();

  while ((m = linkRe.exec(html)) !== null) {
    const link = absolutizeRidi(m[1]);
    if (seen.has(link)) continue;
    seen.add(link);

    // 링크 주변에서 title 추출 시도
    const idx = m.index;
    const slice = html.slice(Math.max(0, idx - 500), idx + 500);

    const title =
      extractBetween(slice, /title="([^"]+)"/) ||
      extractBetween(slice, /aria-label="([^"]+)"/) ||
      "";

    items.push({
      title: title || "제목 미확인",
      link,
      coverUrl: "",
      bookId: (m[1].match(/\/books\/(\d+)/) || [])[1] || "",
    });

    if (items.length >= 20) break; // 너무 많이 긁지 않기
  }

  return items.filter(x => x.link);
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

    const items = parseRidiSearchResults(html);

    return res.status(200).json({
      ok: true,
      q,
      items,
      source: "html-fallback",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      stack: e?.stack || null,
    });
  }
};
