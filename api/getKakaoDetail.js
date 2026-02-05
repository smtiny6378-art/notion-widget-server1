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

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean)));
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

function extractContentId(url) {
  const u = String(url || "");
  const m = u.match(/\/content\/[^/]+\/(\d+)/);
  if (m) return m[1];
  const m2 = u.match(/\/content\/(\d+)/);
  if (m2) return m2[1];
  return "";
}

// ✅ content/text/{id} 페이지의 __NEXT_DATA__에서 authors/genre 추출
function parseFromTextEndpointNextData(nextJson, contentId) {
  // (글에서 확인된 경로) props.initialState.content.contentMap[id] :contentReference[oaicite:1]{index=1}
  const id = String(contentId || "");
  const map =
    nextJson?.props?.initialState?.content?.contentMap ||
    nextJson?.props?.pageProps?.initialState?.content?.contentMap ||
    null;

  const node = map?.[id] || null;
  if (!node) return null;

  // authors: string | array | object 등 변형 대비
  let authorName = "";
  const a = node.authors ?? node.author ?? node.authorName ?? "";
  if (typeof a === "string") authorName = a.trim();
  else if (Array.isArray(a)) authorName = uniq(a.map(x => (typeof x === "string" ? x : x?.name))).join(", ");
  else if (a && typeof a === "object" && a.name) authorName = String(a.name).trim();

  // genre: string | array
  let genre = [];
  const g = node.genre ?? node.genres ?? [];
  if (typeof g === "string") genre = [g.trim()].filter(Boolean);
  else if (Array.isArray(g)) genre = uniq(g);

  // isAdult도 여기서 더 정확할 수 있음
  const isAdult = Boolean(node.isAdult);

  // title도 여기서 가져올 수 있음(ogTitle 없을 때 대비)
  const title = (node.title || "").toString().trim();

  return { authorName, genre, isAdult, title };
}

module.exports = async function handler(req, res) {
  try {
    const url = (req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "Referer": "https://webtoon.kakao.com/",
    };

    // 1) 원래 content URL에서 og 메타(설명/표지) 확보
    const r = await fetch(url, { headers, redirect: "follow" });
    const html = await r.text();
    const $ = cheerio.load(html);

    const ogTitle = $("meta[property='og:title']").attr("content")?.trim() || "";
    const ogDesc = $("meta[property='og:description']").attr("content")?.trim() || "";
    const ogImage = $("meta[property='og:image']").attr("content")?.trim() || "";

    let title = ogTitle || $("h1,h2,h3").first().text().trim() || "";
    if (!title) title = titleFromKakaoUrl(url);

    const desc = ogDesc || "";
    const cover = absolutize(ogImage);

    // 기본 성인 판정(페이지 텍스트 기반)
    let isAdult = html.includes("19세") || html.includes("성인");

    // 2) ✅ content/text/{id}에서 __NEXT_DATA__로 author/genre 확정 추출
    const contentId = extractContentId(url);
    let authorName = "";
    let genre = [];
    let usedTextEndpoint = "";

    if (contentId) {
      const textUrl = `https://webtoon.kakao.com/content/text/${contentId}`;
      const tr = await fetch(textUrl, {
        headers: { ...headers, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        redirect: "follow",
      });

      const thtml = await tr.text();
      const $t = cheerio.load(thtml);
      const nextRaw = $t("#__NEXT_DATA__").text() || "";
      const nextJson = safeJsonParse(nextRaw);

      if (nextJson) {
        const picked = parseFromTextEndpointNextData(nextJson, contentId);
        if (picked) {
          if (picked.authorName) authorName = picked.authorName;
          if (picked.genre?.length) genre = picked.genre;
          if (typeof picked.isAdult === "boolean") isAdult = picked.isAdult || isAdult;
          if (!title && picked.title) title = picked.title;
          usedTextEndpoint = textUrl;
        }
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
      ...(req.query.debug ? { contentId, usedTextEndpoint } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
