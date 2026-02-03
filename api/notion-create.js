const https = require("https");
const zlib = require("zlib");

function decodeMaybeCompressed(buffer, encoding) {
  const enc = (encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buffer).toString("utf8");
    if (enc.includes("gzip")) return zlib.gunzipSync(buffer).toString("utf8");
    if (enc.includes("deflate")) return zlib.inflateSync(buffer).toString("utf8");
  } catch {}
  return buffer.toString("utf8");
}

function getHtmlFollow(url, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    const doReq = (currentUrl, left) => {
      const u = new URL(currentUrl);

      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + (u.search || ""),
          method: "GET",
          headers: {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6",
            "accept-encoding": "gzip, deflate, br",
            "referer": "https://page.kakao.com/",
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          const location = res.headers?.location ? String(res.headers.location) : "";

          if ([301, 302, 303, 307, 308].includes(status) && location && left > 0) {
            const nextUrl = new URL(location, currentUrl).toString();
            return doReq(nextUrl, left - 1);
          }

          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const enc = res.headers?.["content-encoding"] || "";
            const html = decodeMaybeCompressed(buf, enc);
            resolve({ status, html: html || "" });
          });
        }
      );

      req.on("error", reject);
      req.end();
    };

    doReq(url, maxRedirects);
  });
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function pickMeta(html, propertyName) {
  const re = new RegExp(
    `<meta[^>]+property=["']${propertyName}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m && m[1] ? decodeHtml(m[1]).trim() : "";
}

function pickNameDesc(html) {
  const re = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i;
  const m = html.match(re);
  return m && m[1] ? decodeHtml(m[1]).trim() : "";
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

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}

// ✅ 노션 rich_text에서 줄바꿈/여백이 “원문처럼” 보이도록 정규화
// - \r\n → \n
// - 연속 공백/들여쓰기를 최대한 보존하고 싶으면 그대로 두는 게 좋음
function normalizeForNotion(text) {
  if (!text) return "";
  return String(text).replace(/\r\n/g, "\n");
}

module.exports = async function handler(req, res) {
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

    const inputTitle = String(body.title || "").trim();
    const author = String(body.author || "").trim();
    const publisher = String(body.publisher || "").trim();
    const genre = String(body.genre || "").trim();
    const keywords = Array.isArray(body.keywords) ? body.keywords.map(String).map(s => s.trim()).filter(Boolean) : [];
    const inputDesc = String(body.desc || "").trim();

    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    const contentId = extractContentId(url);

    // OG 메타
    let ogTitle = "";
    let ogImage = "";
    let ogDesc = "";

    const upstream = await getHtmlFollow(url, 6);
    if (upstream.status >= 200 && upstream.status < 300) {
      const html = upstream.html || "";
      ogTitle = pickMeta(html, "og:title");
      ogImage = pickMeta(html, "og:image");
      ogDesc  = pickMeta(html, "og:description") || pickNameDesc(html);
    }

    const title = inputTitle || ogTitle || (contentId ? `카카오페이지 작품 (${contentId})` : "카카오페이지 작품");

    // ✅ 작품 소개: 자동 꼬리표/시간/링크 등 추가하지 않음
    // ✅ 줄바꿈/여백 유지용 normalize 적용
    const desc = normalizeForNotion(inputDesc || ogDesc || "");

    const rawCoverUrl = ogImage || "";

    // 이미지 프록시(노션에서 외부 이미지가 안 뜨는 케이스 대비)
    const baseUrl = getBaseUrl(req);
    const proxiedCoverUrl = rawCoverUrl
      ? `${baseUrl}/api/imageProxy?url=${encodeURIComponent(rawCoverUrl)}`
      : "";

    // properties
    const properties = {
      "제목": { title: [{ text: { content: title } }] },
      "플랫폼": { select: { name: platform } },
      "URL": { url },
    };

    if (author) properties["작가명"] = { rich_text: [{ text: { content: author } }] };
    if (publisher) properties["출판사명"] = { rich_text: [{ text: { content: publisher } }] };
    if (genre) properties["장르"] = { select: { name: genre } };
    if (keywords.length) properties["키워드"] = { multi_select: keywords.map(k => ({ name: k })) };

    if (desc) {
      properties["작품 소개"] = { rich_text: [{ text: { content: desc } }] };
    }

    // 표지(files)
    if (proxiedCoverUrl) {
      properties["표지"] = {
        files: [{ name: "cover", type: "external", external: { url: proxiedCoverUrl } }]
      };
    }

    // ✅ 페이지 커버만 유지 (갤러리 '페이지 커버'용)
    const pageCover = proxiedCoverUrl
      ? { type: "external", external: { url: proxiedCoverUrl } }
      : undefined;

    // ✅ 페이지 콘텐츠(본문 이미지 블록) 삽입은 "삭제" → children를 아예 보내지 않음

    const payload = {
      parent: { database_id: NOTION_DB_ID },
      properties,
      ...(pageCover ? { cover: pageCover } : {})
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
      scraped: { title: !!ogTitle, cover: !!rawCoverUrl, desc: !!ogDesc }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
