// /api/searchKakao.js
function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, "").trim();
}

module.exports = async function handler(req, res) {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q required" });

    // ✅ 핵심: site:로 webtoon.kakao.com 안에서만 찾게 강제
    // content/숫자 형태가 나와야 contentId를 뽑을 수 있어.
    const query = `site:webtoon.kakao.com/content ${q}`;

    const r = await fetch(
      `https://dapi.kakao.com/v2/search/web?query=${encodeURIComponent(query)}&size=20&sort=accuracy`,
      {
        headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
      }
    );

    const data = await r.json();

    const itemsRaw = (data.documents || []).map((d) => ({
      title: stripHtml(d.title),
      link: d.url || "",
    }));

    const items = itemsRaw
      .map((it) => {
        const idMatch = (it.link || "").match(/content\/(\d+)/);
        const contentId = idMatch?.[1];
        if (!contentId) return null;
        return { ...it, contentId };
      })
      .filter(Boolean);

    // 중복 제거(contentId 기준)
    const seen = new Set();
    const uniq = [];
    for (const it of items) {
      if (seen.has(it.contentId)) continue;
      seen.add(it.contentId);
      uniq.push(it);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      q,
      usedQuery: query,
      count: uniq.length,
      items: uniq,
      // 디버그용(필요하면 보고 지워도 됨)
      debugTopUrls: itemsRaw.slice(0, 5).map((x) => x.link),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
