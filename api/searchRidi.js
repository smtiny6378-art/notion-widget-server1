// api/searchRidi.js
// ✅ RIDI 내부 검색 API 직호출 버전 (정확한 작품 결과)

function absolutizeRidi(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (!s) return "";
  if (s.startsWith("http")) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return "https://ridibooks.com" + s;
  return s;
}

async function fetchJson(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://ridibooks.com/",
  };
  const r = await fetch(url, { headers });
  const json = await r.json();
  return { ok: r.ok, status: r.status, json };
}

function normalizeTitle(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const q = String(req.query?.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q is required" });

    // ✅ RIDI 내부 검색 API (웹에서 실제로 쓰는 엔드포인트)
    const apiUrl =
      `https://ridibooks.com/api/search?keyword=${encodeURIComponent(q)}&type=books&page=1&size=20`;

    const { ok, status, json } = await fetchJson(apiUrl);

    if (!ok || !json) {
      return res.status(200).json({
        ok: true,
        q,
        items: [],
        source: "ridi_api_failed",
        debug: { status },
      });
    }

    const list =
      json?.data?.items ||
      json?.items ||
      json?.results ||
      [];

    const items = list.map((it) => {
      const bookId = String(it.book_id || it.id || "").trim();
      const link = bookId ? `https://ridibooks.com/books/${bookId}` : "";

      const cover =
        absolutizeRidi(
          it.cover_image ||
          it.coverImage ||
          it.thumbnail ||
          it.thumbnail_url ||
          ""
        );

      const isAdult = Boolean(it.adult || it.is_adult || (cover && cover.includes("cover_adult.png")));

      return {
        title: normalizeTitle(it.title || it.book_title || ""),
        link,
        bookId,
        coverUrl: cover,
        isAdult,
      };
    }).filter(x => x.link && x.title);

    return res.status(200).json({
      ok: true,
      q,
      items,
      source: "ridi_internal_api",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
};
