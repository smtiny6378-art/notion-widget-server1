// api/kakaopage-search.js
// GET /api/kakaopage-search?q=검색어
// fetch 없이 https로 호출 (Node 버전 상관없이 동작)

const https = require("https");

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(url);

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

  try {
    const url = "https://page.kakao.com/graphql";

    const query = `
      query SearchKeyword($input: SearchKeywordInput!) {
        searchKeyword(searchKeywordInput: $input) {
          list {
            id
            thumbnail
            row1
            row2
            row3 { metaList }
            ageGrade
            seriesId
            scheme
            eventLog { eventMeta { series_id } }
          }
        }
      }
    `;

    const variables = {
      input: {
        page: 1,
        sortType: "Latest",
        keyword: q,
        showOnlyComplete: false
      }
    };

    const upstream = await postJson(url, { query, variables });

    if (!upstream.status || upstream.status < 200 || upstream.status >= 300) {
      return res.status(502).json({
        ok: false,
        error: "KakaoPage upstream error",
        status: upstream.status,
        detail: String(upstream.body || "").slice(0, 500),
      });
    }

    let data;
    try {
      data = JSON.parse(upstream.body);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: "Upstream returned non-JSON",
        detail: String(upstream.body || "").slice(0, 500),
      });
    }

    const list = data?.data?.searchKeyword?.list || [];

    const detectContentType = (it) => {
      const meta = []
        .concat(Array.isArray(it?.row3?.metaList) ? it.row3.metaList : [])
        .concat(Array.isArray(it?.row2) ? it.row2 : [])
        .filter(Boolean)
        .map(v => String(v).toLowerCase());

      const joined = meta.join(" ");
      if (joined.includes("웹툰") || joined.includes("만화")) return "webtoon";
      if (joined.includes("웹소설") || joined.includes("소설")) return "novel";
      return "unknown";
    };

    const items = list.map((it) => {
      const seriesId = it?.eventLog?.eventMeta?.series_id || it?.seriesId || it?.id;
      const title = it?.row1 || "";
      const row2 = Array.isArray(it?.row2) ? it.row2 : [];
      const genre = row2[0] || "";
      const author = row2[1] || "";
      const link = seriesId ? `https://page.kakao.com/content/${seriesId}` : (it?.scheme || "");
      const contentType = detectContentType(it);

      return {
        title,
        link,
        coverUrl: it?.thumbnail || "",
        platform: "카카오페이지",
        author,
        genre,
        ageGrade: it?.ageGrade ?? null,
        meta: it?.row3?.metaList || [],
        seriesId: seriesId || "",
        contentType,
      };
    });

    return res.status(200).json({ ok: true, q, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
