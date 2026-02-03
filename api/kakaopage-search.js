// api/kakaopage-search.js
// GET /api/kakaopage-search?q=검색어
// - https로 POST
// - 브라우저 헤더 흉내
// - 301/302/303/307/308 리다이렉트 따라감
// - Location도 detail에 찍어서 디버깅 가능

const https = require("https");

function postJsonFollow(url, payload, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);

    const doRequest = (currentUrl, redirectsLeft) => {
      const u = new URL(currentUrl);

      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + (u.search || ""),
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),

            // ✅ 브라우저처럼 보이게 하는 헤더들 (302 방지에 도움)
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "accept": "application/json, text/plain, */*",
            "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6",
            "origin": "https://page.kakao.com",
            "referer": "https://page.kakao.com/",
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          const location = res.headers && res.headers.location ? String(res.headers.location) : "";

          // ✅ 리다이렉트 처리
          if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
            const nextUrl = new URL(location, currentUrl).toString();
            return doRequest(nextUrl, redirectsLeft - 1);
          }

          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status, body, location }));
        }
      );

      req.on("error", reject);
      req.write(data);
      req.end();
    };

    doRequest(url, maxRedirects);
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

    const upstream = await postJsonFollow(url, { query, variables }, 6);

    // ✅ 200이 아니면, 어디로 리다이렉트 됐는지(location)까지 같이 보여주게 함
    if (!upstream.status || upstream.status < 200 || upstream.status >= 300) {
      return res.status(502).json({
        ok: false,
        error: "KakaoPage upstream error",
        status: upstream.status,
        detail: (upstream.body || "").slice(0, 300),
        location: upstream.location || ""
      });
    }

    let data;
    try {
      data = JSON.parse(upstream.body);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: "Upstream returned non-JSON",
        detail: String(upstream.body || "").slice(0, 300),
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
