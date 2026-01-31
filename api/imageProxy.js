export const config = {
  runtime: "nodejs",
};

async function getFetch() {
  // Node 18+면 글로벌 fetch가 있음
  if (typeof fetch !== "undefined") return fetch;

  // 없으면 node-fetch를 동적 import (설치돼 있어야 함)
  const mod = await import("node-fetch");
  return mod.default;
}

export default async function handler(req, res) {
  const debug = req.query.debug === "1";

  try {
    const imageUrl = req.query.url;

    if (!imageUrl) {
      res.status(400).send("Missing image url");
      return;
    }

    if (!/^https?:\/\//i.test(imageUrl)) {
      res.status(400).send("Invalid url");
      return;
    }

    const fetchFn = await getFetch();

    const r = await fetchFn(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://ridibooks.com/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!r.ok) {
      const msg = `Failed to fetch image: ${r.status}`;
      res.status(502).send(debug ? msg : "Image proxy error");
      return;
    }

    const contentType = r.headers.get("content-type") || "image/jpeg";

    // node-fetch(구버전)와 글로벌 fetch가 반환하는 타입이 다를 수 있어 안전 처리
    let buffer;
    if (typeof r.arrayBuffer === "function") {
      const ab = await r.arrayBuffer();
      buffer = Buffer.from(ab);
    } else if (typeof r.buffer === "function") {
      buffer = await r.buffer();
    } else {
      throw new Error("No supported body reader (arrayBuffer/buffer)");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.status(200).end(buffer);
} catch (err) {
  console.error("Image proxy error:", err);
  const cause = err?.cause ? {
    name: err.cause.name,
    code: err.cause.code,
    message: err.cause.message
  } : null;

  res.status(500).send(
    "Image proxy error\n\n" +
    (err?.stack || err?.message || String(err)) +
    "\n\ncause:\n" +
    JSON.stringify(cause, null, 2)
  );
}
    if (debug) {
      res
        .status(500)
        .send(`Image proxy error\n\n${err?.stack || err?.message || String(err)}`);
    } else {
      res.status(500).send("Image proxy error");
    }
  }
}
