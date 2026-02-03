// api/kakaopage-search.js
// Vercel Serverless Function (Node 18+)
// GET /api/kakaopage-search?q=검색어

export default async function handler(req, res) {
  // CORS (Notion 위젯 iframe에서도 호출 가능하게)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

  try {
    // 카카오페이지는 GraphQL로 검색 데이터를 내려줌. :contentReference[oaicite:1]{index=1}
    // 아래 쿼리는 공개 API가 아니라 내부용이라, 필드가 바뀌면 수정이 필요할 수 있음.
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
          total
          isEnd
          keyword
          page
        }
      }
    `;

    // categoryUid는 카테고리(웹툰/웹소설/책 등) 필터로 쓰이는데,
    // 여기선 "전체 느낌"으로 가장 흔히 쓰이는 10을 기본값으로 둠(필요하면 프론트에서 옵션화 가능).
    const variables = {
      input: {
        categoryUid: "10",
        page: 1,
        sortType: "Latest",
        keyword: q,
        showOnlyComplete: false,
      },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ ok: false, error: "KakaoPage upstream error", detail: text.slice(0, 500) });
    }

    const data = await r.json();
    const list = data?.data?.searchKeyword?.list || [];

    // 위젯에서 쓰기 쉬운 형태로 정리
    const items = list.map((it) => {
      const seriesId = it?.eventLog?.eventMeta?.series_id || it?.seriesId || it?.id;
      const title = it?.row1 || "";
      const row2 = Array.isArray(it?.row2) ? it.row2 : [];
      const genre = row2[0] || "";
      const author = row2[1] || "";

      // content 페이지는 보통 /content/{id} 형태 :contentReference[oaicite:2]{index=2}
      const link = seriesId ? `https://page.kakao.com/content/${seriesId}` : (it?.scheme || "");

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
      };
    });

    return res.status(200).json({ ok: true, q, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}
