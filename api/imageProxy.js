// api/imageProxy.js
// GET /api/imageProxy?url=https%3A%2F%2F...jpg
// 외부 이미지를 서버가 대신 받아서 그대로 전달 (Notion 핫링크/차단 회피용)

const https = require("https");
const http = require("http");

function fetchBuffer(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const doReq = (u, left) => {
      const urlObj = new URL(u);
      const lib = urlObj.protocol === "http:" ? http : https;

      const req = lib.request(
        u,
        {
          method: "GET",
          headers: {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "referer": "https://page.kakao.com/",
          }
        },
        (res) => {
          const status = res.statusCode || 0;
          const location = res.headers?.location ? String(res.headers.location) : "";

          if ([301, 302, 303, 307, 308].includes(status) && location && left > 0) {
            const nextUrl = new URL(location, u).toString();
            return doReq(nextUrl, left - 1);
          }

          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            resolve({
              status,
              buffer: buf,
              contentType: (res.headers["content-type"] || "application/octet-stream").toString()
            });
          });
        }
      );

      req.on("error", reject);
      req.end();
    };

    doReq(targetUrl, maxRedirects);
  });
}

module.exports = async function handler(req, res) {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).send("Missing url");

    // 기본적인 안전장치: 너무 긴 URL 차단
    if (url.length > 2000) return res.status(400).send("URL too long");

    const fetched = await fetchBuffer(url, 6);
    if (!fetched.status || fetched.status < 200 || fetched.status >= 300) {
      return res.status(502).send("Upstream image error");
    }

    // 캐시(노션이 재요청 덜 하게)
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", fetched.contentType);
    return res.status(200).send(fetched.buffer);
  } catch (e) {
    return res.status(500).send("Proxy error");
  }
};
