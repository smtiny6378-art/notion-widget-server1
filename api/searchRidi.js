// api/searchRidi.js
// ✅ No external dependencies

function safeJsonBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {}
  }
  return body || {};
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const q = (req.query?.q || "").toString().trim();
    if (!q) return res.status(400).json({ ok: false, error: "q is required" });

    // RIDI 검색 API (웹에서 쓰는 내부 API)
    const url = `https://ridibooks.com/api/v2/search?q=${encodeURIComponent(q)}&types=book`;

    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
      },
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ ok: false, error: "RIDI API failed", status: r.status, body: t });
    }

    const data = await r.json();

    const items = (data?.results || []).map((it) => {
      const bookId = it?.book?.id || it?.id || "";
      const title = it?.book?.title || it?.title || "";
      const link = bookId ? `https://ridibooks.com/books/${bookId}` : "";
      const coverUrl = it?.book?.cover_url || it?.cover_url || "";

      return {
        title,
        link,
        bookId: String(bookId),
        coverUrl,
      };
    }).filter(x => x.title && x.link);

    return res.status(200).json({ ok: true, q, items });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      stack: e?.stack || null,
    });
  }
};
