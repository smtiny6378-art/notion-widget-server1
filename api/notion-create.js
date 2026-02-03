// api/notion-create.js
// POST /api/notion-create
// body 예시:
// {
//   "title": "카카오페이지 작품 (65171279)",
//   "platform": "카카오페이지",
//   "url": "https://page.kakao.com/content/65171279",
//   "coverUrl": "",               // 선택
//   "author": "",                 // 선택
//   "publisher": "",              // 선택
//   "genre": "",                  // 선택 (select)
//   "keywords": [],               // 선택 (multi-select) 예: ["로맨스", "현대물"]
//   "desc": ""                    // 선택 (rich_text)
// }

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB_ID = process.env.NOTION_DB_ID;

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN or NOTION_DB_ID" });
  }

  try {
    const body = (typeof req.body === "string") ? JSON.parse(req.body) : (req.body || {});
    const title = String(body.title || "").trim();
    const platform = String(body.platform || "카카오페이지").trim();
    const url = String(body.url || "").trim();
    const coverUrl = String(body.coverUrl || "").trim();
    const author = String(body.author || "").trim();
    const publisher = String(body.publisher || "").trim();
    const genre = String(body.genre || "").trim();
    const keywords = Array.isArray(body.keywords) ? body.keywords.map(String).map(s => s.trim()).filter(Boolean) : [];
    const desc = String(body.desc || "").trim();

    if (!title) return res.status(400).json({ ok: false, error: "Missing title" });
    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    // ✅ 네 노션 DB 속성명에 맞춘 매핑
    // - 플랫폼 (select)
    // - 표지 (files)
    // - 작가명 (rich_text)
    // - 출판사명 (rich_text)
    // - 장르 (select)
    // - 키워드 (multi-select)
    // - URL (URL)
    // - 작품 소개 (rich_text)
    //
    // ⚠️ 문제: Title(제목) 속성 이름을 사용자가 안 적어줬음.
    // 보통 "제목" 또는 "이름"이어서 두 개를 순서대로 시도함.

    const makeProperties = (titlePropName) => {
      const props = {};

      // Title (제목/이름 중 하나)
      props[titlePropName] = { title: [{ text: { content: title } }] };

      // 플랫폼 (select)
      if (platform) props["플랫폼"] = { select: { name: platform } };

      // URL (url)
      props["URL"] = { url };

      // 작가명 (rich_text)
      if (author) props["작가명"] = { rich_text: [{ text: { content: author } }] };

      // 출판사명 (rich_text)
      if (publisher) props["출판사명"] = { rich_text: [{ text: { content: publisher } }] };

      // 장르 (select)
      if (genre) props["장르"] = { select: { name: genre } };

      // 키워드 (multi-select)
      if (keywords.length) props["키워드"] = { multi_select: keywords.map(k => ({ name: k })) };

      // 표지 (files)
      // Notion files 속성은 external URL로 넣을 수 있어 (이미지 URL이어야 잘 보임)
      if (coverUrl) {
        props["표지"] = {
          files: [
            {
              name: "cover",
              type: "external",
              external: { url: coverUrl }
            }
          ]
        };
      }

      // 작품 소개 (rich_text)
      // 지금은 자동으로 본문을 가져오기 어렵기 때문에,
      // 최소로 URL과 메모를 넣어두는 형태가 안정적.
      const defaultDesc =
        `카카오페이지 링크: ${url}\n` +
        `저장 시각: ${new Date().toISOString()}`;

      props["작품 소개"] = {
        rich_text: [{ text: { content: desc || defaultDesc } }]
      };

      return props;
    };

    async function createPageWithTitleProp(titlePropName) {
      const payload = {
        parent: { database_id: NOTION_DB_ID },
        properties: makeProperties(titlePropName)
      };

      const r = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${NOTION_TOKEN}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28"
        },
        body: JSON.stringify(payload)
      });

      const data = await r.json();
      return { ok: r.ok, status: r.status, data };
    }

    // 1차: 제목
    let result = await createPageWithTitleProp("제목");

    // 2차: 이름 (만약 제목 속성이 없다면)
    if (!result.ok) {
      const msg = JSON.stringify(result.data || {});
      if (msg.includes("Could not find property") || msg.includes("property") || msg.includes("제목")) {
        const retry = await createPageWithTitleProp("이름");
        if (retry.ok) {
          return res.status(200).json({ ok: true, pageId: retry.data.id, usedTitleProp: "이름" });
        }
        return res.status(502).json({ ok: false, error: "Notion API error", detail: retry.data });
      }
      return res.status(502).json({ ok: false, error: "Notion API error", detail: result.data });
    }

    return res.status(200).json({ ok: true, pageId: result.data.id, usedTitleProp: "제목" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
