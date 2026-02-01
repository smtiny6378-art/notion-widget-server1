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

function pickPropName(props, candidates, type) {
  for (const name of candidates) {
    if (props[name] && (!type || props[name].type === type)) return name;
  }
  return null;
}

function firstPropOfType(props, type) {
  return Object.keys(props).find(k => props[k].type === type) || null;
}

// multi-select 옵션이 DB에 없으면 에러 나는 경우가 있어: 존재하는 옵션만 넣기
function filterToExistingMultiSelectOptions(dbProp, names) {
  const options = dbProp?.multi_select?.options || [];
  const allowed = new Set(options.map(o => o.name));
  return names.filter(n => allowed.has(n));
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }

  const title = body?.title?.toString().trim();
  const urlValue = (body?.url ?? body?.link)?.toString?.().trim?.() || "";
  const coverUrl = body?.coverUrl?.toString().trim();
  const isAdult = toBoolean(body?.isAdult);
  const descriptionFromMeta = body?.meta ? String(body.meta) : "";
  const tags = normalizeArray(body?.tags);

  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ error: "NOTION_DB_ID is missing" });

    // ✅ DB 스키마 읽기
    const db = await notion.databases.retrieve({ database_id: databaseId });
    const props = db?.properties || {};

    // ---- 후보 이름들(여기서 자동으로 실제 속성명을 찾음) ----
    const titleProp = pickPropName(props, ["제목", "Title", "이름", "Name"], "title") || firstPropOfType(props, "title");

    const urlProp = pickPropName(props, ["url", "URL", "링크", "Link", "주소", "Url"], "url") || firstPropOfType(props, "url");

    const coverProp = pickPropName(props, ["표지", "커버", "Cover", "cover", "이미지"], "files") || firstPropOfType(props, "files");

    const descProp = pickPropName(props, ["작품 소개", "설명", "소개", "Description"], "rich_text") || pickPropName(props, ["작품 소개", "설명", "소개", "Description"], "text"); // (노션 UI 'text'는 API 'rich_text')

    const keywordsProp = pickPropName(props, ["키워드", "태그", "Tags", "tags", "keywords"], "multi_select") || firstPropOfType(props, "multi_select");

    if (!titleProp) {
      return res.status(500).json({
        error: "No Title property found in DB",
        availableProperties: Object.keys(props),
      });
    }

    // 성인작이면 키워드에 "19" 옵션이 있을 때만 추가
    const keywordCandidates = isAdult ? [...tags, "19"] : tags;
    const safeKeywords = keywordsProp
      ? filterToExistingMultiSelectOptions(props[keywordsProp], keywordCandidates)
      : [];

    const properties = {
      [titleProp]: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
      ...(urlProp && urlValue ? { [urlProp]: { url: urlValue } } : {}),
      ...(coverProp && coverUrl
        ? {
            [coverProp]: {
              files: [{ type: "external", name: "cover", external: { url: coverUrl } }],
            },
          }
        : {}),
      ...(descProp && descriptionFromMeta
        ? { [descProp]: { rich_text: toRichText(descriptionFromMeta) } }
        : {}),
      ...(keywordsProp && safeKeywords.length
        ? { [keywordsProp]: { multi_select: safeKeywords.map(name => ({ name })) } }
        : {}),
    };

    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });

    return res.status(200).json({
      ok: true,
      pageId: created.id,
      mappedProperties: { titleProp, urlProp, coverProp, descProp, keywordsProp },
      skippedBecauseOptionMissing: {
        keywords: keywordCandidates.filter(x => !safeKeywords.includes(x)),
      },
    });
  } catch (e) {
    // ✅ 디버깅 도움: DB 속성명 리스트를 같이 내려줌
    try {
      const db = await notion.databases.retrieve({ database_id: process.env.NOTION_DB_ID });
      return res.status(500).json({
        error: e?.message || "Unknown error",
        availableProperties: Object.keys(db?.properties || {}),
        details: e?.body || null,
      });
    } catch (_) {
      return res.status(500).json({ error: e?.message || "Unknown error", details: e?.body || null });
    }
  }
};
