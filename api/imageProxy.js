import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    const imageUrl = req.query.url;

    if (!imageUrl) {
      return res.status(400).send("Missing image url");
    }

    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://ridibooks.com",
      },
    });

    if (!response.ok) {
      return res.status(502).send("Failed to fetch image");
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Image proxy error:", err);
    res.status(500).send("Image proxy error");
  }
}
