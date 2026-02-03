// api/notion-create.js
// POST /api/notion-create

module.exports = async function handler(req, res) {
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
    const title = (body.title || "").toString().trim();

    if (!title) return res.status(400).json({ ok: false, error: "Missing title" });

    const platform = (body.platform || "카카오페이지").toString();
    const url = (body.url || "").toString();
    const coverUrl = (body.coverUrl || "").toString();
    const author = (body.author || "").toString();
    const genre = (body.genre || "").toString();
    const ageGrade = body.ageGrade;

    // ✅ 너 DB 속성명에 맞춰야 함 (리디 위젯이 쓰던 속성명 그대로 쓰는 걸 추천)
    const properties = {
      "제목": { title: [{ text: { content: title } }] },
      "플랫폼": { select: { name: platform } },
      "URL": url ? { url } : undefined,
      "작가명": author ? { rich_text: [{ text: { content: author } }] } : undefined,
      "장르": genre ? { multi_select: [{ name: genre }] } : undefined,
      "연령": (ageGrade !== null && ageGrade !== undefined)
        ? { rich_text: [{ text: { content: String(ageGrade) } }] }
        : undefined,
    };

    Object.keys(properties).forEach((k) => properties[k] === undefined && delete properties[k]);

    const payload = {
      parent: { database_id: NOTION_DB_ID },
      properties,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "자동 저장됨 (카카오페이지 위젯)" } }] },
        },
      ],
    };

    if (coverUrl) payload.cover = { type: "external", external: { url: coverUrl } };

    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ ok: false, error: "Notion API error", detail: data });

    return res.status(200).json({ ok: true, pageId: data.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
