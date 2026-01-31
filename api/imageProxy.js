// api/imageProxy.js
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const imageUrl = req.query?.url;

  if (!imageUrl) {
    res.status(400).send("Missing url");
    return;
  }

  if (!/^https?:\/\//i.test(imageUrl)) {
    res.status(400).send("Invalid url");
    return;
  }

  try {
    // Node24 fetch(undici) + 리디 CDN 대응 헤더
    const r = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://ridibooks.com/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });

    if (!r.ok) {
      const msg = `Upstream fetch failed: ${r.status}`;
      res.status(502).send(msg);
      return;
    }

    const contentType = r.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType);

    // 캐시 (속도 개선)
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");

    res.status(200).end(buffer);
  } catch (err) {
    console.error("imageProxy error:", err, err?.cause);
    // 디버그용으로 원인까지 보여주기
    const cause = err?.cause
      ? `${err.cause.name || ""} ${err.cause.code || ""} ${err.cause.message || ""}`
      : "";

    res.status(500).send(`image proxy error\n${String(err)}\n${cause}`);
  }
}
