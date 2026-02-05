// /api/searchKakao.js
module.exports = async function handler(req, res) {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q required" });

    const r = await fetch(
      `https://dapi.kakao.com/v2/search/web?query=${encodeURIComponent(q + " 카카오웹툰")}&size=10`,
      {
        headers: {
          Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}`,
        },
      }
    );

    const data = await r.json();

    const items = (data.documents || [])
      .map((d) => {
        const link = d.url || "";
        const idMatch = link.match(/content\/(\d+)/);
        const contentId = idMatch?.[1];
        if (!contentId) return null;

        return {
          title: d.title?.replace(/<[^>]*>/g, "").trim(),
          link,
          contentId,
        };
      })
      .filter(Boolean);

    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, q, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
