// api/searchKakao.js
const cheerio = require("cheerio");

function normalizeSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean)));
}

function stripTitleSuffix(rawTitle) {
  let t = String(rawTitle || "").trim();
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

function extractContentId(url) {
  const m = String(url || "").match(/\/content\/(\d+)/);
  return m ? m[1] : "";
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ✅ body 텍스트에서 "제목 + 작가" 형태를 추정
function extractAuthorFromTitleLine(pageText, title) {
  const t = normalizeSpace(title);
  if (!t) return "";

  const lines = String(pageText || "")
    .split("\n")
    .map((l) => normalizeSpace(l))
    .filter(Boolean);

  const candidates = lines
    .filter((l) => l.includes(t))
    .sort((a, b) => a.length - b.length);

  if (!candidates.length) return "";

  const line = candidates[0];
  const idx = line.indexOf(t);
  const after = normalizeSpace(line.slice(idx + t.length));

  if (!after) return "";
  if (after.includes("웹툰") || after.includes("웹소설") || after.includes("연재")) return "";

  const cut = after.split("  ")[0].trim();
  return cut.slice(0, 80);
}

// ✅ 소개글 내 "ⓒ ..." 크레딧에서 작가명 후보 추출(최후의 보강)
function extractAuthorFromCopyright(desc) {
  const s = String(desc || "");
  const m = s.match(/ⓒ\s*([^/]+)\s*\//);
  if (!m || !m[1]) return "";
  // "기준석, 연장점검, 지안" 같은 형태
  return normalizeSpace(m[1]).replace(/\s*,\s*/g, ",");
}

// ✅ 장르 텍스트 추정 (보수적)
function extractGenreFromText(pageText) {
  const text = normalizeSpace(pageText);
  if (!text) return [];

  const genres = [];

  const m = text.match(/웹툰\s*([가-힣A-Za-z·\s]{2,30})/);
  if (m && m[1]) {
    const g = normalizeSpace(m[1])
      .split(" ")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => x !== "리스트" && x !== "구분자" && x !== "연재");
    genres.push(...g.slice(0, 3));
  }

  return uniq(genres);
}

// ✅ 스크립트 안 JSON/텍스트에서 작가/장르 후보를 가볍게 추출
function extractFromScriptsLoosely(html) {
  const out = { authorName: "", genre: [] };
  const src = String(html || "");
  if (!src) return out;

  const authorKeys = ["author", "authors", "writer", "writers", "authorName"];
  for (const k of authorKeys) {
    const re = new RegExp(`"${k}"\\s*:\\s*"([^"]{2,80})"`, "i");
    const m = src.match(re);
    if (m && m[1]) {
      const name = normalizeSpace(m[1]);
      if (name) { out.authorName = name; break; }
    }
  }

  const genreKeys = ["genre", "genres", "category", "categories"];
  for (const k of genreKeys) {
    const reArr = new RegExp(`"${k}"\\s*:\\s*\\[([^\\]]{2,200})\\]`, "i");
    const mArr = src.match(reArr);
    if (mArr && mArr[1]) {
      const picks = mArr[1]
        .split(",")
        .map(s => s.replace(/["']/g, "").trim())
        .filter(Boolean)
        .filter(s => s.length <= 20);
      if (picks.length) { out.genre = uniq(picks).slice(0, 3); break; }
    }

    const reOne = new RegExp(`"${k}"\\s*:\\s*"([^"]{2,20})"`, "i");
    const mOne = src.match(reOne);
    if (mOne && mOne[1]) {
      const g = normalizeSpace(mOne[1]);
      if (g) { out.genre = uniq([g]); break; }
    }
  }

  return out;
}

// ✅ __NEXT_DATA__ 추출
function extractNextDataJson($) {
  const raw = ($("#__NEXT_DATA__").text() || "").trim();
  if (!raw) return null;
  return safeJsonParse(raw);
}

// ✅ __NEXT_DATA__를 재귀 탐색해서 episode/viewer id 후보 찾기
function findEpisodeIdFromNextData(nextJson) {
  const results = [];
  const maxNodes = 30000; // 안전장치
  let visited = 0;

  const KEY_RE = /(first|represent|opening|default|latest)?\w*(episode|viewer)\w*id/i;

  function walk(node, path = "") {
    if (!node || visited >= maxNodes) return;
    visited++;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`);
      return;
    }

    if (typeof node === "object") {
      for (const k of Object.keys(node)) {
        const v = node[k];
        const p = path ? `${path}.${k}` : k;

        // 숫자 id 후보
        if (KEY_RE.test(k)) {
          if (typeof v === "number" && v >= 10000) results.push({ key: k, id: String(v), path: p });
          if (typeof v === "string" && /^\d{5,}$/.test(v)) results.push({ key: k, id: v, path: p });
        }

        // 어떤 객체든 계속 탐색
        walk(v, p);
        if (visited >= maxNodes) break;
      }
    }
  }

  walk(nextJson);

  if (!results.length) return { id: "", hits: [] };

  // 우선순위: first/opening/default/represent 같은 느낌의 키를 먼저
  const score = (r) => {
    const k = r.key.toLowerCase();
    if (k.includes("first")) return 1;
    if (k.includes("opening")) return 2;
    if (k.includes("default")) return 3;
    if (k.includes("represent")) return 4;
    if (k.includes("latest")) return 5;
    return 9;
  };

  results.sort((a, b) => score(a) - score(b));
  return { id: results[0].id, hits: results.slice(0, 10) };
}

// ✅ viewer URL 찾기: 링크 -> regex -> NEXT_DATA episodeId
function findViewerUrlStrong(html, $, contentId) {
  // 1) a[href*="/viewer/"]
  const a = $("a[href*='/viewer/']").first().attr("href");
  if (a) {
    const href = String(a).trim();
    if (href.startsWith("http")) return href;
    if (href.startsWith("/")) return "https://page.kakao.com" + href;
  }

  // 2) html에 박혀있는 viewer 링크
  const mAbs = String(html || "").match(/https:\/\/page\.kakao\.com\/content\/\d+\/viewer\/\d+/);
  if (mAbs) return mAbs[0];

  const mRel = String(html || "").match(/\/content\/\d+\/viewer\/\d+/);
  if (mRel) return "https://page.kakao.com" + mRel[0];

  // 3) __NEXT_DATA__에서 episode/viewer id 찾아 조합
  if (contentId) {
    const nextJson = extractNextDataJson($);
    if (nextJson) {
      const picked = findEpisodeIdFromNextData(nextJson);
      if (picked.id) return `https://page.kakao.com/content/${contentId}/viewer/${picked.id}`;
    }
  }

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
  const html = await r.text();
  return html;
}

module.exports = async function handler(req, res) {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const ogTitle = pickMeta($, { prop: "og:title" });
    const ogDesc = pickMeta($, { prop: "og:description" }) || pickMeta($, { name: "description" });
    const ogImage = pickMeta($, { prop: "og:image" });

    const titleBase = stripTitleSuffix(ogTitle) || stripTitleSuffix($("title").text());
    const title = titleBase || "";

    const coverUrl = absolutize(ogImage);
    let desc = (ogDesc || "").trim();
    let isAdult = detectAdult(html, $);

    const pageText = $("body").text() || "";
    let authorName = extractAuthorFromTitleLine(pageText, title);
    let genre = extractGenreFromText(pageText);

    // 스크립트 보강
    const loose = extractFromScriptsLoosely(html);
    if (!authorName && loose.authorName) authorName = loose.authorName;
    if (!genre.length && loose.genre?.length) genre = loose.genre;

    // viewer 보강 (NEXT_DATA 포함)
    const contentId = extractContentId(url);
    const viewerUrl = findViewerUrlStrong(html, $, contentId);
    let usedViewer = "";

    // debug: NEXT_DATA에서 id 후보가 뭔지 보여주기
    let debugHints = undefined;
    if (req.query.debug) {
      const nextJson = extractNextDataJson($);
      const picked = nextJson ? findEpisodeIdFromNextData(nextJson) : { id: "", hits: [] };
      debugHints = {
        viewerAbs: (String(html || "").match(/https:\/\/page\.kakao\.com\/content\/\d+\/viewer\/\d+/g) || []).slice(0, 3),
        viewerRel: (String(html || "").match(/\/content\/\d+\/viewer\/\d+/g) || []).slice(0, 3),
        nextEpisodePicked: picked.id || "",
        nextEpisodeHits: picked.hits || [],
        flags: { hasNext: Boolean($("#__NEXT_DATA__").text()), hasEpisodeWord: String(html).includes("episode") || String(html).includes("Episode") },
      };
    }

    if (viewerUrl) {
      try {
        const vhtml = await fetchHtml(viewerUrl);
        const $v = cheerio.load(vhtml);

        const vDesc = pickMeta($v, { prop: "og:description" }) || pickMeta($v, { name: "description" });
        const vTitle = stripTitleSuffix(pickMeta($v, { prop: "og:title" })) || "";

        if (vDesc && vDesc.length > desc.length) desc = vDesc.trim();
        isAdult = detectAdult(vhtml, $v) || isAdult;

        const vText = $v("body").text() || "";
        if (!authorName) authorName = extractAuthorFromTitleLine(vText, title) || extractAuthorFromTitleLine(vText, vTitle) || authorName;
        if (!genre.length) genre = extractGenreFromText(vText);

        const loose2 = extractFromScriptsLoosely(vhtml);
        if (!authorName && loose2.authorName) authorName = loose2.authorName;
        if (!genre.length && loose2.genre?.length) genre = loose2.genre;

        usedViewer = viewerUrl;
      } catch {
        // viewer 실패해도 content 결과는 반환
      }
    }

    // 최후 보강: desc의 ⓒ 크레딧에서 authorName 추출
    if (!authorName) {
      const c = extractAuthorFromCopyright(desc);
      if (c) authorName = c;
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
      ...(req.query.debug ? { usedViewer, debugHints } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
