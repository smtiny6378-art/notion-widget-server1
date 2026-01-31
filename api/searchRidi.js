// api/searchRidi.js
const cheerio = require("cheerio");

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = (req.query?.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "q is required" });

  try {
    // 리디 검색 URL: https://ridibooks.com/search?q=검색어  :contentReference[oaicite:0]{index=0}
    const url = `https://ridibooks.com/search?q=${encodeURIComponent(q)}`;

    const r = await fetch(url, {
      headers: {
        // 간단한 UA (차단 방지용)
        "User-Agent": "Mozilla/5.0",
      },
    });

    const html = await r.text();
    const $ = cheerio.load(html);

    // ⚠️ 리디 페이지 구조가 바뀌면 selector는 조정이 필요할 수 있어.
    // 일단 "작품 카드 링크"를 최대한 넓게 잡아서 title/link를 뽑는 방식.
    const items = [];
    $("a").each((_, a) => {
      const href = $(a).attr("href") || "";
      const text = $(a).text().trim();

      // 작품 상세로 보이는 링크만 (너무 넓으면 필터 강화)
      if (!href) return;
      if (!text) return;

      // ridibooks는 상대경로가 많아서 보정
      const link = href.startsWith("http") ? href : `https://ridibooks.com${href}`;

      // 너무 긴 텍스트/메뉴 텍스트는 제외
      if (text.length > 60) return;

      // 중복 제거
      if (items.some((x) => x.link === link)) return;

      // 검색어가 제목에 어느 정도 포함되는 경우만 우선 수집(완전 엄격하진 않게)
      if (!text.includes(q) && q.length >= 2) return;

      items.push({
        title: text,
        link,
      });
    });

    res.status(200).json({ ok: true, q, items: items.slice(0, 12) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
