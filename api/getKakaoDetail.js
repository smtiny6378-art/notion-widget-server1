// /api/getKakaoDetail.js
const cheerio = require("cheerio");

function absolutize(u) {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  if (u.startsWith("//")) return "https:" + u;
  return "https://webtoon.kakao.com" + u;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// 깊은 곳에서 키로 값 찾기(가벼운 DFS)
function findFirstByKey(obj, key) {
  const seen = new Set();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Object.prototype.hasOwnProperty.call(cur, key)) return cur[key];

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
  }
  return null;
}

function collectStrings(obj, keys) {
  const out = [];
  const seen = new Set();
  const stack = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    for (const k of keys) {
      const v = cur[k];
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
  }

  return out;
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
      },
    });

    const html = await r.text();
    const $ = cheerio.load(html);

    // 기본 메타
    const title =
      $("meta[property='og:title']").attr("content")?.trim() ||
      $("h1,h2,h3").first().text().trim() ||
      "";

    const desc =
      $("meta[property='og:description']").attr("content")?.trim() ||
      "";

    const cover =
      absolutize($("meta[property='og:image']").attr("content")?.trim() || "");

    const isAdult = html.includes("19세") || html.includes("성인");

    // ✅ Next.js 데이터에서 author/genre 뽑기
    let authorName = "";
    let genre = [];

    const nextDataRaw = $("#__NEXT_DATA__").text() || "";
    const nextData = safeJsonParse(nextDataRaw);

    if (nextData) {
      // author 후보 키들
      // (카카오웹툰 내부 구조가 바뀔 수 있어 다양한 키를 훑음)
      const authorCandidates = collectStrings(nextData, ["author", "name", "penName"]);
      // 너무 많이 잡힐 수 있어서, '작가' 근처 구조를 먼저 찾는 시도
      const authorsObj = findFirstByKey(nextData, "authors") || findFirstByKey(nextData, "author");
      if (authorsObj) {
        const names = collectStrings(authorsObj, ["name", "penName"]);
        if (names.length) authorName = Array.from(new Set(names)).join(", ");
      } else {
        // fallback: 전체에서 name만 막 잡지 말고, 그래도 없으면 비워둠
        authorName = "";
      }

      const genresObj = findFirstByKey(nextData, "genres") || findFirstByKey(nextData, "genre");
      if (genresObj) {
        const gs = collectStrings(genresObj, ["name"]);
        genre = Array.from(new Set(gs)).filter(Boolean);
      }
    }

    // ✅ DOM fallback(NextData 실패 대비)
    if (!authorName) {
      // 페이지 어디엔가 "작가" 텍스트 주변이 있을 때를 대비한 약한 fallback
      const text = $("body").text();
      // 너무 공격적으로 뽑으면 오염되니 여기선 비워둠(안전)
      authorName = authorName || "";
      // 장르도 안전하게 비움
      genre = genre || [];
      void text;
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      platform: "카카오웹툰",
      title,
      authorName,
      genre,         // 배열
      desc,
      cover,
      isAdult,
      url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
