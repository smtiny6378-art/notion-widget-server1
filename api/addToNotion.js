const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function toRichText(value) {
  const s = value == null ? "" : String(value).trim();
  if (!s) return [];
  return [{ type: "text", text: { content: s.slice(0, 2000) } }];
}

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,|]/g).map(s => s.trim()).filter(Boolean);
  return [];
}

function toBoolean(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "y" || s === "yes";
  }
  return false;
}

function filterToExistingMultiSelectOptions(dbProp, names) {
  const options = dbProp?.multi_select?.options || [];
  const allowed = new Set(options.map(o => o.name));
  return names.filter(n => allowed.has(n));
}

module.exports = async (req, res) => {
  // ✅ CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  // body 파싱
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }

  const title = body?.title?.toString().trim();
  const url = (body?.url ?? body?.link)?.toString?.().trim?.() || "";
  const coverUrl = body?.coverUrl?.toString().trim();
  const isAdult = toBoolean(body?.isAdult);

  // ✅ 지금 네 API에서는 meta가 "작품 소개 텍스트"로 내려옴
  const descriptionFromMeta = body?.meta ? String(body.meta) : "";

  // ✅ tags -> 노션 "키워드" (Multi-select)
  // + 성인작이면 키워드에 "19" 옵션이 있을 때만 추가
  const tags = normalizeArray(body?.tags);
  const keywordCandidates = isAdult ? [...tags, "19"] : tags;

  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ error: "NOTION_DB_ID is missing" });

    // DB 스키마 가져오기 (키워드 옵션 필터링용)
    const db = await notion.databases.retrieve({ database_id: databaseId });
    const props = db?.properties || {};

    // 키워드 multi-select 옵션(존재하는 옵션만 넣기)
    const safeKeywords = filterToExistingMultiSelectOptions(props["키워드"], keywordCandidates);

    const properties = {
      // 제목 (Title)
      "제목": { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },

      // url (URL)
      ...(url ? { "url": { url } } : {}),

      // 표지 (Files)
      ...(coverUrl
        ? {
            "표지": {
              files: [
                { type: "external", name: "cover", external: { url: coverUrl } },
              ],
            },
          }
        : {}),

      // 작품 소개 (text -> API에선 rich_text)
      ...(descriptionFromMeta
        ? { "작품 소개": { rich_text: toRichText(descriptionFromMeta) } }
        : {}),

      // 키워드 (Multi-select) - DB에 있는 옵션만
      ...(safeKeywords.length
        ? { "키워드": { multi_select: safeKeywords.map(name => ({ name })) } }
        : {}),
    };

    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });

    return res.status(200).json({
      ok: true,
      pageId: created.id,
      saved: {
        title,
        url: !!url,
        coverUrl: !!coverUrl,
        description: !!descriptionFromMeta,
        keywords: safeKeywords,
        isAdult,
      },
      skippedBecauseOptionMissing: {
        keywords: keywordCandidates.filter(x => !safeKeywords.includes(x)),
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || "Unknown error",
      details: e?.body || null,
    });
  }
};
