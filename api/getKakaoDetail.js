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

// JSON-LD에서 author/genre 뽑기(creator/contributor까지 포함)
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

      const takeName = (x) => {
        if (!x) return [];
        if (typeof x === "string") return [x.trim()];
        if (Array.isArray(x)) return x.flatMap(takeName);
        if (typeof x === "object") {
          if (x.name) return [String(x.name).trim()];
          // creator/author가 Person 형태일 때
          if (x["@type"] === "Person" && x.name) return [String(x.name).trim()];
        }
        return [];
      };

      // author → 없으면 creator/contributor도 시도
      if (!authorName) {
        const names = uniq([
          ...takeName(node.author),
          ...takeName(node.creator),
          ...takeName(node.contributor),
        ]);
        if (names.length) authorName = names.join(", ");
      }

      if (genre.length === 0) {
        genre = normalizeGenreValue(node.genre);
      }

      if (genre.length === 0 && node.keywords) {
        genre = normalizeGenreValue(node.keywords);
      }

      if (authorName || genre.length) break;
    }

    if (authorName || genre.length) break;
  }

  return { authorName, genre };
}

// ✅ HTML 원문에서 author 키 문자열을 정규식으로 직접 추출
function parseAuthorByRegex(html) {
  const patterns = [
    /"authorName"\s*:\s*"([^"]+)"/,
    /"writerName"\s*:\s*"([^"]+)"/,
    /"drawerName"\s*:\s*"([^"]+)"/,
    /"artistName"\s*:\s*"([^"]+)"/,
    /"penName"\s*:\s*"([^"]+)"/,
    /"creatorName"\s*:\s*"([^"]+)"/,
  ];

  const found = [];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) found.push(m[1]);
  }

  // 중복 제거 + 너무 긴 문자열 제거
  return uniq(found).filter((s) => s.length <= 40).join(", ");
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

    // ✅ 1.5) meta name="author"도 확인
    if (!authorName) {
      const metaAuthor =
        $("meta[name='author']").attr("content")?.trim() ||
        $("meta[property='book:author']").attr("content")?.trim() ||
        "";
      if (metaAuthor) authorName = metaAuthor;
    }

    // ✅ 2) Next.js 데이터 fallback
    if (!authorName || genre.length === 0) {
      const nextData = safeJsonParse($("#__NEXT_DATA__").text() || "");
      if (nextData) {
        if (!authorName) {
          const preferredAuthors = uniq(collectByKeys(nextData, [
            "authorName", "writerName", "drawerName", "artistName", "creatorName", "penName"
          ]));
          if (preferredAuthors.length) authorName = preferredAuthors.join(", ");
        }
        if (genre.length === 0) {
          const genreCandidates = uniq(collectByKeys(nextData, [
            "genreName", "categoryName", "categoryTitle", "tagName", "genre"
          ]));
          genre = genreCandidates.filter(s => s.length <= 20).slice(0, 5);
        }
      }
    }

    // ✅ 2.5) HTML regex fallback (작가명만이라도 반드시 건지기)
    if (!authorName) {
      const regexAuthor = parseAuthorByRegex(html);
      if (regexAuthor) authorName = regexAuthor;
    }

    // ✅ 3) 텍스트 fallback(최후)
    if (!authorName || genre.length === 0) {
      const bodyText = $("body").text().replace(/\s+/g, " ");

      if (!authorName) {
        const m =
          bodyText.match(/작가\s*[:：]?\s*([가-힣A-Za-z0-9·._\-, ]{2,40})/) ||
          bodyText.match(/글\s*[:：]?\s*([가-힣A-Za-z0-9·._\-, ]{2,40})/) ||
          bodyText.match(/그림\s*[:：]?\s*([가-힣A-Za-z0-9·._\-, ]{2,40})/);
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
