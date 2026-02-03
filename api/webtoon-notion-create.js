// api/webtoon-notion-create.js
// POST /api/webtoon-notion-create
// body: { url }

const https = require("https");
const zlib = require("zlib");

// decompress if needed
function decodeMaybeCompressed(buffer, encoding) {
  if (!buffer) return "";
  const enc = (encoding || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buffer).toString("utf8");
    if (enc.includes("gzip")) return zlib.gunzipSync(buffer).toString("utf8");
    if (enc.includes("deflate")) return zlib.inflateSync(buffer).toString("utf8");
  } catch {}
  return buffer.toString("utf8");
}

// follow redirects & get HTML
function fetchHtml(url, maxRedirects = 5) {
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
            "referer": "https://webtoon.kakao.com",
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          const loc = res.headers?.location || "";
          // follow 30x redirects
          if ([301,302,303,307,308].includes(status) && loc && left > 0) {
            const nextUrl = new URL(loc, currentUrl).toString();
            return doReq(nextUrl, left - 1);
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const html = decodeMaybeCompressed(buf, res.headers["content-encoding"]);
            resolve({ status, html, finalUrl: currentUrl });
          });
        }
      );
      req.on("error", reject);
      req.end();
    };

    doReq(url, maxRedirects);
  });
}

// decode HTML entities
function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// extract text between html
function extractText(html, regex) {
  const m = html.match(regex);
  return m && m[1] ? decodeHtml(m[1]).trim() : "";
}

// simple CSS selector-like extraction
function extractBetween(html, start, end) {
  const idx = html.indexOf(start);
  if (idx === -1) return "";
  const part = html.substring(idx + start.length);
  const idx2 = part.indexOf(end);
  if (idx2 === -1) return "";
  return decodeHtml(part.substring(0, idx2)).trim();
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
    return res.status(500).json({ ok: false, error: "No Notion token/db" });
  }

  try {
    const body = JSON.parse(req.body || "{}");
    const url = String(body.url || "").trim();
    if (!url) return res.status(400).json({ ok:false, error:"Missing url" });

    // fetch HTML
    const { status, html } = await fetchHtml(url, 6);

    // get OG title
    let title = extractText(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (!title) {
      // fallback: page title tag
      title = extractText(html, /<title[^>]*>([^<]+)<\/title>/i);
    }

    // get cover
    let coverUrl = extractText(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);

    // extract author
    // look for <span class="author"> ... </span>
    let author = extractBetween(html,
      `<dt class="tit_info">작가</dt>`,
      `</dd>`);
    if (author) {
      // strip tags inside
      author = author.replace(/<[^>]+>/g,"").trim();
    }

    // extract genre
    let genre = extractBetween(html,
      `<dt class="txt_genre">장르</dt>`,
      `</dd>`);
    if (genre) {
      genre = genre.replace(/<[^>]+>/g,"").trim();
    }

    // extract description
    let desc = extractBetween(html,
      `<div class="detail_info">`,
      `</div>`);
    if (desc) {
      desc = desc.replace(/<[^>]+>/g,"").trim();
    }

    // Proxy cover if exists
    let proxiedCover = "";
    if (coverUrl) {
      const base = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
      proxiedCover = `${base}/api/imageProxy?url=${encodeURIComponent(coverUrl)}`;
    }

    // build props
    const props = {
      "제목": { title: [{ text: { content: title || "" } }] },
      "플랫폼": { select: { name: "카카오웹툰" } },
      "URL": { url },
    };
    if (author) props["작가명"] = { rich_text: [{ text: { content: author } }] };
    if (genre) props["장르"] = { select: { name: genre } };
    if (desc) props["작품 소개"] = { rich_text: [{ text: { content: desc } }] };
    if (proxiedCover) {
      props["표지"] = {
        files: [{ name:"cover", type:"external", external:{url:proxiedCover} }]
      };
    }

    const notionPayload = {
      parent: { database_id: NOTION_DB_ID },
      properties: props,
    };

    // set page cover for gallery
    if (proxiedCover) {
      notionPayload.cover = { type:"external", external:{url:proxiedCover} };
    }

    // create page
    const r = await fetch("https://api.notion.com/v1/pages", {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type":"application/json",
        "Notion-Version":"2022-06-28",
      },
      body: JSON.stringify(notionPayload),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ ok:false, error:"Notion API error", detail:data });
    return res.status(200).json({ ok:true, pageId:data.id });

  } catch(e){
    return res.status(500).json({ ok:false, error:e.message||"Unknown error" });
  }
};
