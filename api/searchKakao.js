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

// ✅ contentId 추출 (page.kakao.com/content/12345)
function extractContentId(url) {
  const m = String(url || "").match(/\/content\/(\d+)/);
  return m ? m[1] : "";
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

// ✅ 장르 텍스트 추정 (보수적)
function extractGenreFromText(pageText) {
  const text = normalizeSpace(pageText);
  if (!text) return [];

  const genres = [];

  // 예: "웹툰 드라마" / "웹툰 로맨스 판타지"
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

// ✅ 스크립트 안 JSON/텍스트에서 작가/장르 후보를 추가 추출 (있으면만)
function extractFromScripts(html) {
  const out = { authorName: "", genre: [] };

  // 작가 후보 키워드들
  const authorKeys = ["author", "authors", "writer", "writers", "작가", "저자"];
  const genreKeys = ["genre", "genres", "category", "categories", "장르"];

  // 너무 비싸게 전체 파싱하지 않고 문자열 패턴 기반으로만 가볍게 시도
  const lower = String(html || "");
  if (!lower) return out;

  // "작가명":"..." 같은 패턴
  for (const k of authorKeys) {
    // JSON 스타일: "author":"NAME" 또는 "authorName":"NAME"
    const re = new RegExp(`"${k}\\w*"\\s*:\\s*"([^"]{2,80})"`, "i");
    const m = lower.match(re);
    if (m && m[1]) {
      const name = normalizeSpace(m[1]);
      // 너무 흔한 값(예: "true" 등) 방지
      if (name && name.length >= 2 && name.length <= 80) {
        out.authorName = name;
        break;
      }
    }
  }

  // 장르 후보: "genre":"드라마" / "genres":["드라마","판타지"]
  for (const k of genreKeys) {
    // 배열 형태
    const reArr = new RegExp(`"${k}\\w*"\\s*:\\s*\\[([^\\]]{2,200})\\]`, "i");
    const mArr = lower.match(reArr);
    if (mArr && mArr[1]) {
      // "드라마","판타지" 형태만 대충 분리
      const picks = mArr[1]
        .split(",")
        .map(s => s.replace(/["']/g, "").trim())
        .filter(Boolean)
        .filter(s => s.length <= 20);
      if (picks.length) out.genre = uniq(picks).slice(0, 3);
      if (out.genre.length) break;
    }

    // 단일 문자열 형태
    const reOne = new RegExp(`"${k}\\w*"\\s*:\\s*"([^"]{2,20})"`, "i");
    const mOne = lower.match(reOne);
    if (mOne && mOne[1]) {
      const g = normalizeSpace(mOne[1]);
      if (g) out.genre = uniq([g]);
      if (out.genre.length) break;
    }
  }

  return out;
}

// ✅ viewer URL 찾기 강화 (가장 중요!)
function findViewerUrlStrong(html, $, contentId) {
  // 0) contentId가 있으면 viewer URL 후보를 직접 생성할 수는 없지만,
  // viewer id(회차 id)가 필요해서 완전한 생성은 어려움 → 대신 아래 탐색 강화

  // 1) a[href*="/viewer/"] (기본)
  const a = $("a[href*='/viewer/']").first().attr("href");
  if (a) {
    const href = String(a).trim();
    if (href.startsWith("http")) return href;
    if (href.startsWith("/")) return "https://page.kakao.com" + href;
  }

  // 2) html에 박혀있는 절대 viewer 링크
  const mAbs = String(html || "").match(/https:\/\/page\.kakao\.com\/content\/\d+\/viewer\/\d+/);
  if (mAbs) return mAbs[0];

  // 3) html에 박혀있는 상대 viewer 링크
  const mRel = String(html || "").match(/\/content\/\d+\/viewer\/\d+/);
  if (mRel) return "https://page.kakao.com" + mRel[0];

  // 4) JSON 안에 viewerId(또는 episodeId)가 있는 경우를 찾아 조합
  // 흔한 키들: firstEpisodeId, firstViewerId, viewerId, episodeId
  const episodeKeyCandidates = ["firstEpisodeId", "firstViewerId", "viewerId", "episodeId", "episode", "firstEpisode"];
  for (const k of episodeKeyCandidates) {
    const re = new RegExp(`"${k}"\\s*:\\s*(\\d{5,})`, "i");
    const mm = String(html || "").match(re);
    if (mm && mm[1] && contentId) {
      return `https://page.kakao.com/content/${contentId}/viewer/${mm[1]}`;
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

    // ✅ 스크립트에서도 한번 보강
    const fromScripts = extractFromScripts(html);
    if (!authorName && fromScripts.authorName) authorName = fromScripts.authorName;
    if (!genre.length && fromScripts.genre?.length) genre = fromScripts.genre;

    // ✅ viewer 보강 (강화)
    const contentId = extractContentId(url);
    const viewerUrl = findViewerUrlStrong(html, $, contentId);
    let usedViewer = "";

    if (viewerUrl) {
      try {
        const vhtml = await fetchHtml(viewerUrl);
        const $v = cheerio.load(vhtml);

        const vDesc = pickMeta($v, { prop: "og:description" }) || pickMeta($v, { name: "description" });
        const vTitle = stripTitleSuffix(pickMeta($v, { prop: "og:title" })) || "";

        if (vDesc && vDesc.length > desc.length) desc = vDesc.trim();
        isAdult = detectAdult(vhtml, $v) || isAdult;

        const vText = $v("body").text() || "";
        if (!authorName) {
          authorName =
            extractAuthorFromTitleLine(vText, title) ||
            extractAuthorFromTitleLine(vText, vTitle) ||
            authorName;
        }
        if (!genre.length) genre = extractGenreFromText(vText);

        // viewer html 스크립트에서도 마지막 보강
        const fromScripts2 = extractFromScripts(vhtml);
        if (!authorName && fromScripts2.authorName) authorName = fromScripts2.authorName;
        if (!genre.length && fromScripts2.genre?.length) genre = fromScripts2.genre;

        usedViewer = viewerUrl;
      } catch {
        // viewer 실패해도 content 결과는 반환
      }
    }

    res.setHeader("Cache-Control", "no-store");
        // ===== debug hints =====
    let debugHints = undefined;
    if (req.query.debug) {
      const src = html;

      // viewer/episode 관련 숫자 힌트 몇 개만 뽑기 (너무 길면 응답 커짐)
      const viewerAbs = src.match(/https:\/\/page\.kakao\.com\/content\/\d+\/viewer\/\d+/g) || [];
      const viewerRel = src.match(/\/content\/\d+\/viewer\/\d+/g) || [];

      // episode/viewer id로 보이는 숫자키 패턴들
      const keyHits = [];
      const keys = [
        "firstEpisodeId","firstViewerId","viewerId","episodeId","firstContentEpisodeId",
        "defaultEpisodeId","representEpisodeId","latestEpisodeId","openingEpisodeId"
      ];
      for (const k of keys) {
        const re = new RegExp(`"${k}"\\s*:\\s*(\\d{5,})`, "ig");
        let m;
        while ((m = re.exec(src)) && keyHits.length < 10) {
          keyHits.push({ key: k, id: m[1] });
        }
      }

      // __NEXT_DATA__ 같은 큰 초기데이터 존재 여부
      const hasNext = src.includes("__NEXT_DATA__");
      const hasApollo = src.includes("apollo") || src.includes("Apollo");
      const hasEpisodeWord = src.includes("episode") || src.includes("Episode");

      debugHints = {
        viewerAbs: viewerAbs.slice(0, 3),
        viewerRel: viewerRel.slice(0, 3),
        keyHits,
        flags: { hasNext, hasApollo, hasEpisodeWord },
      };
    }

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
