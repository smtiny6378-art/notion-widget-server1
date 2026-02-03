// api/notion-create.js
// POST /api/notion-create
// body: { platform, url }
// - 카카오페이지 작품 페이지 HTML에서 og:title / og:image / og:description 추출
// - gzip/deflate/br 압축 해제 지원

const https = require("https");
const zlib = require("zlib");

function decodeMaybeCompressed(buffer, encoding) {
  const enc = (encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buffer).toString("utf8");
    if (enc.includes("gzip")) return zlib.gunzipSync(buffer).toString("utf8");
    if (enc.includes("deflate")) return zlib.inflateSync(buffer).toString("utf8");
  } catch {
    // 해제 실패 시 fallback
  }
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
            resolve({ status, html });
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

    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    const contentId = extractContentId(url);

    // 1) 카카오페이지 HTML에서 OG 추출
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

    // 2) fallback 값
    const title = ogTitle || (contentId ? `카카오페이지 작품 (${contentId})` : "카카오페이지 작품");
    const coverUrl = ogImage || "";
    const desc =
      (ogDesc ? `${ogDesc}\n\n` : "") +
      `카카오페이지 링크: ${url}\n` +
      (contentId ? `작품 ID: ${contentId}\n` : "") +
      `저장 시각: ${new Date().toISOString()}`;

    // 3) Notion properties (네 속성명 그대로)
    const properties = {
      "제목": { title: [{ text: { content: title } }] },
      "플랫폼": { select: { name: platform } },
      "URL": { url },
      "작품 소개": { rich_text: [{ text: { content: desc } }] },
    };

    if (coverUrl) {
      properties["표지"] = {
        files: [{ name: "cover", type: "external", external: { url: coverUrl } }]
      };
    }

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
      scraped: { title: !!ogTitle, cover: !!coverUrl, desc: !!ogDesc }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
