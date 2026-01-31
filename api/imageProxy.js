export default async function handler(req, res) {
  try {
    const imageUrl = req.query.url;

    if (!imageUrl) {
      res.status(400).send("Missing image url");
      return;
    }

    // 안전: http/https만 허용
    if (!/^https?:\/\//i.test(imageUrl)) {
      res.status(400).send("Invalid url");
      return;
    }

    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://ridibooks.com/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      res.status(502).send(`Failed to fetch image: ${response.status}`);
      return;
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.status(200).send(buffer);
  } catch (err) {
    console.error("Image proxy error:", err);
    res.status(500).send("Image proxy error");
  }
}
