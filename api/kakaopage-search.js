// api/kakaopage-search.js
// ✅ No external dependencies (no cheerio)

function normalizeSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function stripTitleSuffix(rawTitle) {
  let t = String(rawTitle || "").trim();
  t = t.replace(/\s*\|\s*카카오페이지\s*$/i, "").trim();
  t = t.replace(/\s*-\s*웹툰\s*$/i, "").trim();
  t = t.replace(/\s*-\s*웹소설\s*$/i, "").trim();
  t = t.replace(/\s*-\s*책\s*$/i, "").trim();
  return t;
}

function absolutizeKakaoPage(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (!s) return "";
  if (s.startsWith("http")) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return "https://page.kakao.com" + s;
  return s;
}

function getMetaContent(html, { property, name } = {}) {
  const src = String(html || "");
  let re = null;

  if (property) {
    re = new RegExp(
      `<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["'][^>]*>`,
      "i"
    );
    let m = src.match(re);
    if (m && m[1]) return m[1].trim();

    re = new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["'][^>]*>`,
      "i"
    );
    m = src.match(re);
    if (m && m[1]) return m[1].trim();
  }

  if (name) {
    re = new RegExp(
      `<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`,
      "i"
    );
    let m = src.match(re);
    if (m && m[1]) return m[1].trim();

    re = new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["'][^>]*>`,
      "i"
    );
    m = src.match(re);
    if (m && m[1]) return m[1].trim();
  }

  return "";
}

function detectAdultFromHtml(html) {
  const text = String(html || "").toLowerCase();
  return text.includes("19세") || text.includes("성인") || text.includes("청소년 이용불가");
}

function findFirstViewerUrl(html) {
  const src = String(html || "");
  const m1 = src.match(/href=["'](\/content\/\d+\/viewer\/\d+)["']/i);
  if (m1 && m1[1]) return "https://page.kakao.com" + m1[1];

  const m2 = src.match(/https:\/\/page\.kakao\.com\/content\/\d+\/viewer\/\d+/i);
  if (m2 && m2[0]) return m2[0];

  return "";
}

async function fetchHtml(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://page.kakao.com/",
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  return await r.text();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const html = await fetchHtml(url);

    const ogTitle = getMetaContent(html, { property: "og:title" });
    const ogDesc = getMetaContent(html, { property: "og:description" }) || getMetaContent(html, { name: "description" });
    const ogImage = getMetaContent(html, { property: "og:image" });

    let title = stripTitleSuffix(ogTitle);
    if (!title) title = stripTitleSuffix((html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "").trim());

    const coverUrl = absolutizeKakaoPage(ogImage);
    let desc = normalizeSpace(ogDesc);
    let isAdult = detectAdultFromHtml(html);

    const viewerUrl = findFirstViewerUrl(html);
    let usedViewer = "";

    if (viewerUrl) {
      try {
        const vhtml = await fetchHtml(viewerUrl);
        const vDesc = getMetaContent(vhtml, { property: "og:description" }) || getMetaContent(vhtml, { name: "description" });
        const vTitle = stripTitleSuffix(getMetaContent(vhtml, { property: "og:title" }));

        if (!title && vTitle) title = vTitle;

        const vDescN = normalizeSpace(vDesc);
        if (vDescN && vDescN.length > desc.length) desc = vDescN;

        isAdult = detectAdultFromHtml(vhtml) || isAdult;
        usedViewer = viewerUrl;
      } catch {}
    }

    const authorName = "";
    const genre = [];

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "KAKAO",
      title: title || "",
      coverUrl,
      authorName,
      genre,
      desc,
      isAdult,
      url,
      ...(req.query.debug ? { usedViewer } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
