// api/searchRidi.js
const cheerio = require("cheerio");

// Node 버전에 따라 fetch가 없을 수 있어서 안전 처리
async function getFetch() {
  if (typeof fetch !== "undefined") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

// srcset에서 첫 URL만 뽑기
function pickFromSrcset(srcset) {
  if (!srcset) return "";
  // "url 1x, url2 2x" 형태에서 첫 url
  const first = String(srcset).split(",")[0]?.trim() || "";
  return first.split(" ")[0] || "";
}

function absolutizeUrl(u) {
  if (!u) return "";
  const url = String(u).trim();
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http")) return url;
  // 리디는 보통 절대/프로토콜상대라 여기 잘 안 옴. 그래도 안전 처리:
  if (url.startsWith("/")) return "https://ridibooks.com" + url;
  return url;
}

function extractCoverFromAnchor($, a) {
  const $a = $(a);

  // 1) img src / data-src / srcset
  const $img = $a.find("img").first();
  if ($img && $img.length) {
    const src =
      $img.attr("src") ||
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      pickFromSrcset($img.attr("srcset"));
    const abs = absolutizeUrl(src);
    if (abs) return abs;
  }

  // 2) style="background-image: url(...)"
  const styleEl = $a.find("[style*='background-image']").first();
  if (styleEl && styleEl.length) {
    const style = styleEl.attr("style") || "";
    const m = style.match(/url\((['"]?)(.*?)\1\)/i);
    if (m && m[2]) {
      const abs = absolutizeUrl(m[2]);
      if (abs) return abs;
    }
  }

  // 3) a 자체 style background-image
  const aStyle = $a.attr("style") || "";
  const m2 = aStyle.match(/url\((['"]?)(.*?)\1\)/i);
  if (m2 && m2[2]) return absolutizeUrl(m2[2]);

  return "";
}

function extractTitle($, a) {
  const $a = $(a);

  // 1) img alt가 제목인 경우가 많음
  const alt = $a.find("img").first().attr("alt");
  if (alt && String(alt).trim()) return String(alt).trim();

  // 2) aria-label
  const aria = $a.attr("aria-label");
  if (aria && String(aria).trim()) return String(aria).trim();

  // 3) 내부 텍스트(너무 긴 건 제외)
  const text = $a.text().replace(/\s+/g, " ").trim();
  if (text && text.length <= 80) return text;

  return "";
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

    const items = [];
    const seen = new Set();

    // ✅ 핵심: 작품 링크로 보이는 a[href*="/books/"]를 우선 수집
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (!href.includes("/books/")) return;

      const link = href.startsWith("http") ? href : `https://ridibooks.com${href}`;

      // 중복 제거
      if (seen.has(link)) return;

      // 제목 뽑기 (img alt / aria-label / text)
      const title = extractTitle($, a);
      if (!title) return;

      // 검색어 필터(너무 엄격하면 또 누락되니까 느슨하게)
      // - q가 2글자 이상일 때만 포함 체크
      if (q.length >= 2 && !title.includes(q)) return;

      // 표지 뽑기 (src/data-src/srcset/background-image)
      const coverUrl = extractCoverFromAnchor($, a);

      seen.add(link);
      items.push({
        title,
        link,
        coverUrl: coverUrl || undefined,
      });
    });

    // 혹시 너무 적게 뽑히면(페이지 구조 변동) fallback: 네 기존 방식 일부 반영
    if (items.length === 0) {
      $("a").each((_, a) => {
        const href = $(a).attr("href") || "";
        const text = $(a).text().trim();
        if (!href || !text) return;
        if (text.length > 60) return;
        const link = href.startsWith("http") ? href : `https://ridibooks.com${href}`;
        if (seen.has(link)) return;
        if (q.length >= 2 && !text.includes(q)) return;

        seen.add(link);
        items.push({ title: text, link });
      });
    }

    res.status(200).json({ ok: true, q, items: items.slice(0, 12) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
