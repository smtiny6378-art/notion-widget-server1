// /api/getKakaoDetail.js
const cheerio = require("cheerio");

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function absolutize(u) {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  if (u.startsWith("//")) return "https:" + u;
  return "https://webtoon.kakao.com" + u;
}

function titleFromKakaoUrl(url) {
  try {
    const u = String(url || "").trim();
    const m = u.match(/\/content\/([^/]+)\/(\d+)/);
    if (!m) return "";
    const slug = decodeURIComponent(m[1]);
    return slug.replace(/-/g, " ").trim();
  } catch {
    return "";
  }
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean)));
}

function normalizeGenreValue(v) {
  if (!v) return [];
  if (Array.isArray(v)) return uniq(v);
  if (typeof v === "string") return uniq(v.split(/[,/|]/g).map(s => s.trim()));
  return [];
}

// DFS로 특정 키 문자열 수집
function collectByKeys(obj, keyCandidates) {
  const keys = new Set(keyCandidates);
  const out = [];
  const seen = new Set();
  const stack = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }

    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (keys.has(k) && typeof v === "string" && v.trim()) out.push(v.trim());
      stack.push(v);
    }
  }
  return out;
}

// JSON-LD에서 author/genre 뽑기
function parseJsonLd($) {
  let authorName = "";
  let genre = [];

  const scripts = $("script[type='application/ld+json']").toArray();
  for (const s of scripts) {
    const raw = $(s).text();
    if (!raw) continue;

    const data = safeJsonParse(raw);
    if (!data) continue;

    const nodes = Array.isArray(data) ? data : [data];

    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;

      // author: string | {name} | [{name}]
      const a = node.author;
      if (!authorName && a) {
        if (typeof a === "string") authorName = a.trim();
        else if (Array.isArray(a)) {
          const names = a.map(x => (typeof x === "string" ? x : x?.name)).filter(Boolean);
          authorName = uniq(names).join(", ");
        } else if (typeof a === "object" && a.name) {
          authorName = String(a.name).trim();
        }
      }

      // genre: string | array
      const g = node.genre;
      if (genre.length === 0 && g) {
        genre = normalizeGenreValue(g);
      }

      // 일부는 keywords로 주기도 함
      const kw = node.keywords;
      if (genre.length === 0 && kw) {
        genre = normalizeGenreValue(kw);
      }

      if (authorName || genre.length) break;
    }

    if (authorName || genre.length) break;
  }

  return { authorName, genre };
}

module.exports = async function handler(req, res) {
  try {
    const url = (req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "Referer": "https://webtoon.kakao.com/",
      },
      redirect: "follow",
    });

    const html = await r.text();
    const $ = cheerio.load(html);

    const ogTitle = $("meta[property='og:title']").attr("content")?.trim() || "";
    const ogDesc = $("meta[property='og:description']").attr("content")?.trim() || "";
    const ogImage = $("meta[property='og:image']").attr("content")?.trim() || "";

    let title = ogTitle || $("h1,h2,h3").first().text().trim() || "";
    if (!title) title = titleFromKakaoUrl(url);

    const desc = ogDesc || "";
    const cover = absolutize(ogImage);
    const isAdult = html.includes("19세") || html.includes("성인");

    // ✅ 1) JSON-LD 우선
    let { authorName, genre } = parseJsonLd($);

    // ✅ 2) Next.js 데이터 fallback
    if (!authorName || genre.length === 0) {
      const nextData = safeJsonParse($("#__NEXT_DATA__").text() || "");
      if (nextData) {
        if (!authorName) {
          const preferredAuthors = uniq(collectByKeys(nextData, [
            "authorName","authorsName","writerName","drawerName","artistName","creatorName","penName"
          ]));
          authorName = preferredAuthors.join(", ");
        }
        if (genre.length === 0) {
          const genreCandidates = uniq(collectByKeys(nextData, [
            "genreName","categoryName","categoryTitle","tagName","genre"
          ]));
          genre = genreCandidates.filter(s => s.length <= 20).slice(0, 5);
        }
      }
    }

    // ✅ 3) 텍스트 fallback(최후)
    if (!authorName || genre.length === 0) {
      const bodyText = $("body").text().replace(/\s+/g, " ");

      if (!authorName) {
        const m =
          bodyText.match(/작가\s*[:：]?\s*([가-힣A-Za-z0-9·._\-, ]{2,30})/) ||
          bodyText.match(/글\s*[:：]?\s*([가-힣A-Za-z0-9·._\-, ]{2,30})/) ||
          bodyText.match(/그림\s*[:：]?\s*([가-힣A-Za-z0-9·._\-, ]{2,30})/);
        if (m && m[1]) authorName = m[1].trim();
      }

      if (genre.length === 0) {
        const gm = bodyText.match(/장르\s*[:：]?\s*([가-힣A-Za-z0-9·/_\-, ]{2,30})/);
        if (gm && gm[1]) genre = [gm[1].trim()];
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      title,
      authorName,
      genre,
      desc,
      cover,
      isAdult,
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
