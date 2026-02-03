// api/webtoon-parse.js
// POST /api/webtoon-parse
// body: { url }
// returns: { ok, title, author, genre, coverUrl, desc }

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

function fetchHtmlFollow(url, maxRedirects = 6) {
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
            "referer": "https://webtoon.kakao.com/",
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
            resolve({ status, html: html || "", finalUrl: currentUrl });
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

function pickMeta(html, key) {
  const re = new RegExp(
    `<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m && m[1] ? decodeHtml(m[1]).trim() : "";
}

function pickDescription(html) {
  const og = pickMeta(html, "og:description");
  if (og) return og;
  const re = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i;
  const m = html.match(re);
  return m && m[1] ? decodeHtml(m[1]).trim() : "";
}

// ✅ 웹툰 페이지 구조가 바뀔 수 있어서 "약하게" 파싱: JSON-LD / OG / 텍스트 후보를 순서대로 시도
function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tryExtractFromJsonLd(html) {
  // <script type="application/ld+json">...</script> 에 name/author/genre/description/image가 있으면 우선 사용
  const out = { title: "", author: "", genre: "", desc: "", coverUrl: "" };
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const s of scripts) {
    const jsonText = s.replace(/^[\s\S]*?>/i, "").replace(/<\/script>[\s\S]*$/i, "");
    try {
      const data = JSON.parse(jsonText);
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        if (!out.title && item.name) out.title = String(item.name);
        if (!out.desc && item.description) out.desc = String(item.description);
        if (!out.genre && item.genre) out.genre = Array.isArray(item.genre) ? item.genre[0] : String(item.genre);
        if (!out.coverUrl && item.image) out.coverUrl = Array.isArray(item.image) ? item.image[0] : String(item.image);
        if (!out.author && item.author) {
          // author can be string/object/array
          if (typeof item.author === "string") out.author = item.author;
          else if (Array.isArray(item.author)) {
            const names = item.author.map(a => (typeof a === "string" ? a : a?.name)).filter(Boolean);
            out.author = names.join(", ");
          } else if (item.author?.name) out.author = String(item.author.name);
        }
      }
    } catch {}
  }
  // 정리
  out.title = out.title.trim();
  out.author = out.author.trim();
  out.genre = out.genre.trim();
  out.desc = out.desc.trim();
  out.coverUrl = out.coverUrl.trim();
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const body = (typeof req.body === "string") ? JSON.parse(req.body) : (req.body || {});
    const url = String(body.url || "").trim();
    if (!url) return res.status(400).json({ ok:false, error:"Missing url" });

    const u = new URL(url);
    if (!u.hostname.includes("webtoon.kakao.com")) {
      return res.status(400).json({ ok:false, error:"Not a webtoon.kakao.com url" });
    }

    const r = await fetchHtmlFollow(url, 6);
    if (r.status < 200 || r.status >= 300) {
      return res.status(502).json({ ok:false, error:"Upstream error", status:r.status });
    }

    const html = r.html || "";

    // 1) JSON-LD 우선
    const j = tryExtractFromJsonLd(html);

    // 2) OG
    const ogTitle = pickMeta(html, "og:title");
    const ogImage = pickMeta(html, "og:image");
    const ogDesc = pickDescription(html);

    // 결과 합치기
    const title = (j.title || ogTitle || "").trim();
    const coverUrl = (j.coverUrl || ogImage || "").trim();
    const desc = (j.desc || ogDesc || "").trim();

    // author/genre는 페이지마다 구조가 달라서, JSON-LD에서 못 잡히면 빈 값일 수 있어
    const author = (j.author || "").trim();
    const genre = (j.genre || "").trim();

    return res.status(200).json({
      ok: true,
      url,
      title,
      author,
      genre,
      coverUrl,
      desc,
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || "Unknown error" });
  }
};
