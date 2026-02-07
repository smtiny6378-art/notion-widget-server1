// api/searchRidi.js
// ✅ RIDI 검색: 차단/HTML 응답 감지 → JSON으로 우아하게 실패 반환
// - 서버 500 방지
// - 프론트에 "차단됨" 명확히 전달

async function fetchText(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://ridibooks.com/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  const r = await fetch(url, { headers, redirect: "follow" });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

function looksLikeHtml(s) {
  const t = String(s || "").trim().slice(0, 200).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.includes("<head");
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

    const url = `https://ridibooks.com/search?q=${encodeURIComponent(q)}`;
    const fetched = await fetchText(url);

    // ❌ 차단/HTML 응답 감지
    if (!fetched.ok || looksLikeHtml(fetched.text)) {
      return res.status(200).json({
        ok: false,
        blocked: true,
        source: "ridi_html_blocked",
        status: fetched.status,
        error: "RIDI가 서버 요청을 차단하여 검색 결과를 가져올 수 없어요.",
      });
    }

    // 이 아래는 사실상 도달하지 않음(리디가 JSON 안 줌)
    return res.status(200).json({
      ok: true,
      q,
      items: [],
      source: "unreachable",
    });
  } catch (e) {
    // 🔒 어떤 에러가 나도 500 대신 JSON으로
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
};
