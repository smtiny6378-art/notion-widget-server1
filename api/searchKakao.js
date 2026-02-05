// /api/searchKakao.js
function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, "").trim();
}

// contentId 추출: /content/작품명/4387  또는 /content/4387 형태 모두 대응
function extractContentId(url) {
  const u = String(url || "");
  let m = u.match(/\/content\/[^/]+\/(\d+)/); // /content/slug/1234
  if (m) return m[1];
  m = u.match(/\/content\/(\d+)/); // /content/1234 (혹시 존재하면)
  if (m) return m[1];
  return "";
}

async function kakaoSearch(endpoint, query, restKey) {
  const r = await fetch(
    `https://dapi.kakao.com/v2/search/${endpoint}?query=${encodeURIComponent(query)}&size=20&sort=accuracy`,
    { headers: { Authorization: `KakaoAK ${restKey}` } }
  );
  return r.json();
}

module.exports = async function handler(req, res) {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q required" });

    const REST = process.env.KAKAO_REST_KEY;
    if (!REST) return res.status(500).json({ ok: false, error: "Missing KAKAO_REST_KEY env" });

    // ✅ 핵심: site: 말고 "도메인 문자열"을 검색어에 직접 포함
    // 이게 카카오 검색 API에서 훨씬 잘 잡힘.
    const query = `"webtoon.kakao.com/content" ${q}`;

    // 1) web → 2) blog → 3) cafe 순서로 fallback
    const endpoints = ["web", "blog", "cafe"];

    let data = null;
    let usedEndpoint = "";
    for (const ep of endpoints) {
      data = await kakaoSearch(ep, query, REST);
      usedEndpoint = ep;
      const docs = data?.documents || [];
      if (docs.length > 0) break;
    }

    const docs = data?.documents || [];
    const itemsRaw = docs.map((d) => ({
      title: stripHtml(d.title),
      link: d.url || "",
    }));

    const items = itemsRaw
      .map((it) => {
        const contentId = extractContentId(it.link);
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
      usedEndpoint,
      count: uniq.length,
      items: uniq.slice(0, 10),
      debugTopUrls: itemsRaw.slice(0, 5).map((x) => x.link),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
