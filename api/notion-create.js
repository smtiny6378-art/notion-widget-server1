// api/notion-create.js
// POST /api/notion-create
// - URL만 줘도: 카카오페이지 content 페이지 HTML에서 og:title / og:image / og:description을 최대한 추출
// - Notion 속성명: 플랫폼(select), 표지(files), 작가명(rich_text), 출판사명(rich_text), 장르(select), 키워드(multi-select), URL(url), 작품 소개(rich_text)
// - 제목 속성은 스샷 기준 "제목"으로 저장

const https = require("https");

function getWithRedirect(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const doReq = (currentUrl, left) => {
      const u = new URL(currentUrl);

      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + (u.search || ""),
          method: "GET",
          headers: {
            // 카카오페이지가 봇/서버 호출을 민감하게 보는 편이라 브라우저 UA를 넣어줌
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6",
            "referer": "https://page.kakao.com/",
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          const location = res.headers && res.headers.location ? String(res.headers.location) : "";

          // Redirect follow
          if ([301, 302, 303, 307, 308].includes(status) && location && left > 0) {
            const nextUrl = new URL(location, currentUrl).toString();
            return doReq(nextUrl, left - 1);
          }

          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status, body, location }));
        }
      );

      req.on("error", reject);
      req.end();
    };

    doReq(url, maxRedirects);
  });
}

function pickMeta(html, key) {
  // og:title / og:image / og:description 우선
  // property="og:title" content="..."
  const re1 = new RegExp(
    `<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m1 = html.match(re1);
  if (m1 && m1[1]) return decodeHtml(m1[1]);

  // name="description" content="..."
  if (key === "description") {
    const re2 = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i;
    const m2 = html.match(re2);
    if (m2 && m2[1]) return decodeHtml(m2[1]);
  }

  return "";
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractContentId(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/content\/(\d+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

async function enrichFromKakaoPage(url) {
  // 카카오페이지에서 HTML 자체가 막히거나(302) JS 렌더링이면 빈 값이 나올 수 있음
  try {
    const r = await getWithRedirect(url, 6);
    if (!r.status || r.status < 200 || r.status >= 300) {
      return { ok: false, reason: `upstream_status_${r.status}` };
    }

    const html = r.body || "";
    // og 메타
    const ogTitle = pickMeta(html, "og:title");
    const ogImage = pickMeta(html, "og:image");
    const ogDesc = pickMeta(html, "og:description");

    // fallback: title 태그
    let title = ogTitle;
    if (!title) {
      const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (m && m[1]) title = decodeHtml(m[1]).trim();
    }

    // 간단 정리
    return {
      ok: true,
      title: (title || "").trim(),
      coverUrl: (ogImage || "").trim(),
      desc: (ogDesc || "").trim(),
    };
  } catch {
    return { ok: false, reason: "fetch_failed" };
  }
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB_ID = process.env.NOTION_DB_ID;

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
  }

  try {
    const body = (typeof req.body === "string") ? JSON.parse(req.body) : (req.body || {});
    const url = String(body.url || "").trim();
    const platform = String(body.platform || "카카오페이지").trim();

    // 사용자가 입력한 값(있으면 우선)
    let title = String(body.title || "").trim();
    let coverUrl = String(body.coverUrl || "").trim();
    let author = String(body.author || "").trim();
    let publisher = String(body.publisher || "").trim();
    let genre = String(body.genre || "").trim();
    const keywords = Array.isArray(body.keywords) ? body.keywords.map(String).map(s => s.trim()).filter(Boolean) : [];
    let desc = String(body.desc || "").trim();

    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    // ✅ URL 기반 자동 보강(제목/표지/소개)
    // - title/cover/desc가 비어 있을 때만 채움
    const contentId = extractContentId(url);
    const needsEnrich = (!title || !coverUrl || !desc);

    if (needsEnrich) {
      const enriched = await enrichFromKakaoPage(url);
      if (enriched.ok) {
        if (!title && enriched.title) title = enriched.title;
        if (!coverUrl && enriched.coverUrl) coverUrl = enriched.coverUrl;
        if (!desc && enriched.desc) desc = enriched.desc;
      }
    }

    // 그래도 제목이 없으면 fallback
    if (!title) {
      title = contentId ? `카카오페이지 작품 (${contentId})` : "카카오페이지 작품";
    }

    // 작품 소개 기본값(아무것도 못 가져온 경우라도 최소 기록)
    if (!desc) {
      desc =
        `카카오페이지 링크: ${url}\n` +
        (contentId ? `작품 ID: ${contentId}\n` : "") +
        `저장 시각: ${new Date().toISOString()}`;
    } else {
      // 가져온 소개 + 링크/ID도 같이 남겨두기(나중에 검색/확인 편함)
      desc =
        `${desc}\n\n` +
        `카카오페이지 링크: ${url}\n` +
        (contentId ? `작품 ID: ${contentId}\n` : "");
    }

    // ✅ Notion properties (네 속성명에 맞춤)
    const properties = {
      "제목": { title: [{ text: { content: title } }] },
      "플랫폼": { select: { name: platform } },
      "URL": { url },
      "작가명": author ? { rich_text: [{ text: { content: author } }] } : undefined,
      "출판사명": publisher ? { rich_text: [{ text: { content: publisher } }] } : undefined,
      "장르": genre ? { select: { name: genre } } : undefined,
      "키워드": keywords.length ? { multi_select: keywords.map(k => ({ name: k })) } : undefined,
      "표지": coverUrl ? {
        files: [
          { name: "cover", type: "external", external: { url: coverUrl } }
        ]
      } : undefined,
      "작품 소개": { rich_text: [{ text: { content: desc } }] }
    };

    // undefined 제거
    Object.keys(properties).forEach((k) => properties[k] === undefined && delete properties[k]);

    const payload = {
      parent: { database_id: NOTION_DB_ID },
      properties
    };

    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ ok: false, error: "Notion API error", detail: data });

    return res.status(200).json({
      ok: true,
      pageId: data.id,
      filled: {
        title: !!title,
        cover: !!coverUrl,
        desc: !!desc
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
