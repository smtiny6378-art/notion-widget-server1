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

// DFS로 문자열 수집(특정 키 후보만)
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

// DFS로 "이미지 URL처럼 보이는" 문자열 수집
function collectImageUrls(obj) {
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
      if (typeof v === "string" && /^https?:\/\/.+\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(v)) {
        out.push(v);
      }
      // 흔한 키도 추가로 줍기
      if (typeof v === "string" && /(image|thumb|thumbnail|poster|cover)/i.test(k) && v.startsWith("http")) {
        out.push(v);
      }
      stack.push(v);
    }
  }
  return out;
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
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

    // title/desc/cover(메타 우선)
    const ogTitle = $("meta[property='og:title']").attr("content")?.trim() || "";
    const ogDesc = $("meta[property='og:description']").attr("content")?.trim() || "";
    const ogImage = $("meta[property='og:image']").attr("content")?.trim() || "";

    let title = ogTitle || $("h1,h2,h3").first().text().trim() || "";
    if (!title) title = titleFromKakaoUrl(url);

    const desc = ogDesc || "";

    let cover = absolutize(ogImage);

    const isAdult = html.includes("19세") || html.includes("성인");

    // Next.js 데이터 파싱
    let authorName = "";
    let genre = [];

    const nextData = safeJsonParse($("#__NEXT_DATA__").text() || "");
    if (nextData) {
      // 작가 후보 키들
      const authorCandidates = collectByKeys(nextData, [
        "authorName", "authorsName", "writerName", "drawerName", "artistName",
        "creatorName", "penName", "name"
      ]);
      // 너무 많이 잡힐 수 있어서 "name"은 후순위로 쓰되, 다른 키가 있으면 그걸 우선
      const preferredAuthors = collectByKeys(nextData, [
        "authorName", "authorsName", "writerName", "drawerName", "artistName",
        "creatorName", "penName"
      ]);

      const authorPick = uniq(preferredAuthors).length ? uniq(preferredAuthors) : [];
      authorName = authorPick.join(", ");

      // 장르 후보 키들
      const genreCandidates = collectByKeys(nextData, [
        "genreName", "genre", "genres", "categoryName", "category", "categoryTitle", "tagName"
      ]);
      // 너무 잡히면 필터링(너무 긴 문장 제외)
      genre = uniq(genreCandidates).filter((s) => s.length <= 20).slice(0, 5);

      // 표지 후보
      if (!cover) {
        const imgs = uniq(collectImageUrls(nextData));
        // webtoon 관련 도메인 우선
        const preferred = imgs.find((u) => /kakao|daum|kakaocdn|webtoon/i.test(u)) || imgs[0] || "";
        cover = preferred;
      }
    }

    // DOM/텍스트 fallback(NextData 실패 대비)
    if (!authorName || genre.length === 0) {
      const bodyText = $("body").text().replace(/\s+/g, " ");

      if (!authorName) {
        // 예: "작가 홍길동" / "글 홍길동" / "그림 홍길동"
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
