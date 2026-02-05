// /api/getKakaoPageDetail.js
const cheerio = require("cheerio");

function normalizeSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean)));
}

function titleFromContentId(url) {
  // https://page.kakao.com/content/64257452
  const m = String(url || "").match(/\/content\/(\d+)/);
  return m ? m[1] : "";
}

function stripTitleSuffix(rawTitle) {
  let t = String(rawTitle || "").trim();
  // 예: "학원 베이비시터즈 - 웹툰 | 카카오페이지"
  t = t.replace(/\s*\|\s*카카오페이지\s*$/i, "").trim();
  t = t.replace(/\s*-\s*웹툰\s*$/i, "").trim();
  t = t.replace(/\s*-\s*웹소설\s*$/i, "").trim();
  t = t.replace(/\s*-\s*책\s*$/i, "").trim();
  return t;
}

function absolutize(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (!s) return "";
  if (s.startsWith("http")) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return "https://page.kakao.com" + s;
  return s;
}

function pickMeta($, propOrName) {
  // propOrName: { prop: 'og:title' } or { name: 'description' }
  if (propOrName?.prop) {
    return ($(`meta[property='${propOrName.prop}']`).attr("content") || "").trim();
  }
  if (propOrName?.name) {
    return ($(`meta[name='${propOrName.name}']`).attr("content") || "").trim();
  }
  return "";
}

function detectAdult(html, $) {
  const text = `${html}\n${$("body").text()}`.toLowerCase();
  return text.includes("19세") || text.includes("성인") || text.includes("청소년 이용불가");
}

function findFirstViewerUrl(html, $) {
  // content 페이지 내 "첫 화 보기" 링크나 viewer 링크가 들어있는 경우가 있음
  // 1) a[href*="/viewer/"]
  const a = $("a[href*='/viewer/']").first().attr("href");
  if (a) {
    const href = String(a).trim();
    if (href.startsWith("http")) return href;
    if (href.startsWith("/")) return "https://page.kakao.com" + href;
  }

  // 2) html에서 regex로 직접 찾기
  const m = String(html || "").match(/https:\/\/page\.kakao\.com\/content\/\d+\/viewer\/\d+/);
  if (m) return m[0];

  const m2 = String(html || "").match(/\/content\/\d+\/viewer\/\d+/);
  if (m2) return "https://page.kakao.com" + m2[0];

  return "";
}

function extractAuthorFromTitleLine(pageText, title) {
  // 예: "학원 베이비시터즈 HARI TOKEINO"
  // title이 앞에 있고, 뒤에 작가명(영문/한글)이 이어지는 케이스를 추정
  const t = normalizeSpace(title);
  if (!t) return "";

  const lines = String(pageText || "")
    .split("\n")
    .map((l) => normalizeSpace(l))
    .filter(Boolean);

  // title을 포함하는 가장 짧은 라인을 찾기
  const candidates = lines
    .filter((l) => l.includes(t))
    .sort((a, b) => a.length - b.length);

  if (!candidates.length) return "";

  const line = candidates[0];
  // title 이후 부분
  const idx = line.indexOf(t);
  const after = normalizeSpace(line.slice(idx + t.length));

  // 너무 짧거나, 상태/분류만 있으면 제외
  if (!after) return "";
  if (after.includes("웹툰") || after.includes("웹소설") || after.includes("연재")) return "";

  // "제목 + 작가" 형태에서 작가만
  // after가 "HARI TOKEINO" 같은 경우 그대로 사용
  // 너무 긴 경우(다른 설명 포함)는 첫 덩어리만
  const cut = after.split("  ")[0].trim();
  return cut.slice(0, 80);
}

function extractGenreFromText(pageText) {
  // 페이지 텍스트에 "웹툰 | 드라마" 같은 형태가 보일 때가 있어 이를 긁어봄
  const text = normalizeSpace(pageText);
  if (!text) return [];

  // 아주 보수적으로 "웹툰" / "웹소설" / "책" 같은 분류어는 제외하고,
  // 그 옆에 붙는 1~3개의 장르 후보를 뽑아본다.
  const genres = [];

  // 예: "웹툰 드라마" / "웹툰 로맨스 판타지"
  const m = text.match(/웹툰\s*([가-힣A-Za-z·\s]{2,30})/);
  if (m && m[1]) {
    const g = normalizeSpace(m[1])
      .split(" ")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => x !== "리스트" && x !== "구분자" && x !== "연재");
    // 너무 많이 잡히면 앞 3개까지만
    genres.push(...g.slice(0, 3));
  }

  return uniq(genres);
}

async function fetchHtml(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://page.kakao.com/",
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  const html = await r.text();
  return html;
}

module.exports = async function handler(req, res) {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    // 1) content 페이지
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const ogTitle = pickMeta($, { prop: "og:title" });
    const ogDesc = pickMeta($, { prop: "og:description" }) || pickMeta($, { name: "description" });
    const ogImage = pickMeta($, { prop: "og:image" });

    const titleBase = stripTitleSuffix(ogTitle) || stripTitleSuffix($("title").text());
    const title = titleBase || titleFromContentId(url) || "";

    const coverUrl = absolutize(ogImage);
    let desc = (ogDesc || "").trim();
    let isAdult = detectAdult(html, $);

    const pageText = $("body").text() || "";
    let authorName = extractAuthorFromTitleLine(pageText, title);
    let genre = extractGenreFromText(pageText);

    // 2) viewer(첫 화) 페이지를 추가로 시도해서 소개/성인/작가/장르 보강
    const viewerUrl = findFirstViewerUrl(html, $);
    let usedViewer = "";

    if (viewerUrl) {
      try {
        const vhtml = await fetchHtml(viewerUrl);
        const $v = cheerio.load(vhtml);

        const vDesc = pickMeta($v, { prop: "og:description" }) || pickMeta($v, { name: "description" });
        const vTitle = stripTitleSuffix(pickMeta($v, { prop: "og:title" })) || "";
        const vImage = absolutize(pickMeta($v, { prop: "og:image" }));

        // 소개글이 content 페이지보다 viewer가 더 잘 나오는 케이스가 있어서 우선순위 ↑
        if (vDesc && vDesc.length > desc.length) desc = vDesc.trim();

        // 표지가 더 낫다면 교체
        if (!coverUrl && vImage) {
          // content에서 안 잡히면 viewer로 대체
          // (content에 잡혔으면 유지)
        }

        // 성인 여부도 보강
        isAdult = detectAdult(vhtml, $v) || isAdult;

        // 작가/장르가 비어있으면 viewer 텍스트에서도 한 번 더 시도
        const vText = $v("body").text() || "";
        if (!authorName) authorName = extractAuthorFromTitleLine(vText, title) || extractAuthorFromTitleLine(vText, vTitle);
        if (!genre.length) genre = extractGenreFromText(vText);

        usedViewer = viewerUrl;
      } catch {
        // viewer 실패해도 content 결과는 반환
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오페이지",
      title,
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
