// api/addToNotion.js
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

function toBoolean(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "y" || s === "yes";
  }
  return false;
}

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,|]/g).map(s => s.trim()).filter(Boolean);
  return [];
}

// ✅ 노션 rich_text는 1개 조각당 2000자 제한 → 분할 저장
function toRichTextChunks(value, chunkSize = 2000) {
  const s = value == null ? "" : String(value);
  const out = [];
  for (let i = 0; i < s.length; i += chunkSize) {
    const chunk = s.slice(i, i + chunkSize);
    if (chunk.trim()) out.push({ type: "text", text: { content: chunk } });
  }
  return out;
}

function toNumberSafe(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * ✅ Multi-select 옵션이 없으면 DB에 자동 추가
 * - propName: "장르" / "키워드"
 * - values: ["로맨스", "현대물", ...]
 * 반환: { added: ["..."], finalOptions: Set(...) }
 */
async function ensureMultiSelectOptions(databaseId, dbProps, propName, values) {
  if (!values || values.length === 0) return { added: [], finalOptions: new Set() };

  const prop = dbProps[propName];
  if (!prop || prop.type !== "multi_select") {
    // 속성이 없거나 타입이 아니면 아무것도 안 함
    return { added: [], finalOptions: new Set() };
  }

  const existingOptions = prop.multi_select?.options || [];
  const existing = new Set(existingOptions.map(o => o.name));

  // 추가해야 할 옵션들(중복 제거)
  const need = Array.from(new Set(values)).filter(v => v && !existing.has(v));

  if (need.length === 0) {
    return { added: [], finalOptions: existing };
  }

  // ✅ Notion DB 업데이트: 기존 옵션 + 신규 옵션
  // 주의: properties[propName] 구조는 Notion API 형식에 맞춰야 함
  const newOptions = [
    ...existingOptions.map(o => ({ name: o.name })), // 색상은 생략해도 됨
    ...need.map(name => ({ name })),
  ];

  await notion.databases.update({
    database_id: databaseId,
    properties: {
      [propName]: {
        multi_select: {
          options: newOptions,
        },
      },
    },
  });

  // 업데이트 후 최종 옵션 집합
  const finalSet = new Set([...existing, ...need]);
  return { added: need, finalOptions: finalSet };
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
  if (!title) return res.status(400).json({ error: "title is required" });

  // searchRidi에서 내려오는 형태 기준
  const urlValue = (body?.url ?? body?.link)?.toString?.().trim?.() || "";
  const coverUrl = body?.coverUrl?.toString().trim() || "";
  const isAdult = toBoolean(body?.isAdult);

  const authorName = (body?.authorName ?? body?.author ?? "").toString().trim();
  const publisherName = (body?.publisherName ?? body?.publisher ?? "").toString().trim();
  const rating = toNumberSafe(body?.rating);

  const genreArr = normalizeArray(body?.genre);
  const keywordsArr = normalizeArray(body?.keywords ?? body?.tags); // tags를 키워드로 사용
  const guideText = (body?.guide ?? body?.romanceGuide ?? "").toString();
  const description = (body?.description ?? body?.meta ?? "").toString();

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ error: "NOTION_DB_ID is missing" });

    // ✅ DB 스키마 읽기
    let db = await notion.databases.retrieve({ database_id: databaseId });
    let props = db?.properties || {};

    // ---- 네 DB 속성명(고정) ----
    const TITLE_PROP = "제목";
    const URL_PROP = "url";
    const COVER_PROP = "표지";
    const AUTHOR_PROP = "작가명";
    const PUBLISHER_PROP = "출판사명";
    const RATING_PROP = "평점";
    const GENRE_PROP = "장르";
    const KEYWORDS_PROP = "키워드";
    const GUIDE_PROP = "로맨스 가이드";
    const DESC_PROP = "작품 소개";

    // 성인작이면 키워드에 "19" 추가
    const keywordCandidates = isAdult ? [...keywordsArr, "19"] : keywordsArr;

    // ✅ 1) 옵션 자동 생성 (장르/키워드)
    const createdOptions = { genre: [], keywords: [] };

    if (genreArr.length && props[GENRE_PROP]?.type === "multi_select") {
      const r = await ensureMultiSelectOptions(databaseId, props, GENRE_PROP, genreArr);
      createdOptions.genre = r.added;
      if (r.added.length) {
        // DB 스키마 갱신
        db = await notion.databases.retrieve({ database_id: databaseId });
        props = db?.properties || {};
      }
    }

    if (keywordCandidates.length && props[KEYWORDS_PROP]?.type === "multi_select") {
      const r = await ensureMultiSelectOptions(databaseId, props, KEYWORDS_PROP, keywordCandidates);
      createdOptions.keywords = r.added;
      if (r.added.length) {
        db = await notion.databases.retrieve({ database_id: databaseId });
        props = db?.properties || {};
      }
    }

    // ✅ 2) 이제는 옵션이 DB에 있으니 그대로 저장 가능
    const safeGenre = genreArr;
    const safeKeywords = keywordCandidates;

    const properties = {
      [TITLE_PROP]: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },

      ...(props[URL_PROP]?.type === "url" && urlValue ? { [URL_PROP]: { url: urlValue } } : {}),

      ...(props[AUTHOR_PROP]?.type === "rich_text" && authorName
        ? { [AUTHOR_PROP]: { rich_text: toRichTextChunks(authorName) } }
        : {}),

      ...(props[PUBLISHER_PROP]?.type === "rich_text" && publisherName
        ? { [PUBLISHER_PROP]: { rich_text: toRichTextChunks(publisherName) } }
        : {}),

      ...(props[RATING_PROP]?.type === "number" && rating != null
        ? { [RATING_PROP]: { number: rating } }
        : {}),

      ...(props[GENRE_PROP]?.type === "multi_select" && safeGenre.length
        ? { [GENRE_PROP]: { multi_select: safeGenre.map(name => ({ name })) } }
        : {}),

      ...(props[KEYWORDS_PROP]?.type === "multi_select" && safeKeywords.length
        ? { [KEYWORDS_PROP]: { multi_select: safeKeywords.map(name => ({ name })) } }
        : {}),

      ...(props[GUIDE_PROP]?.type === "rich_text" && guideText.trim()
        ? { [GUIDE_PROP]: { rich_text: toRichTextChunks(guideText) } }
        : {}),

      ...(props[DESC_PROP]?.type === "rich_text" && description.trim()
        ? { [DESC_PROP]: { rich_text: toRichTextChunks(description) } }
        : {}),

      ...(props[COVER_PROP]?.type === "files" && coverUrl
        ? {
            [COVER_PROP]: {
              files: [{ type: "external", name: "cover", external: { url: coverUrl } }],
            },
          }
        : {}),
    };

    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      // ✅ 갤러리 카드 표지: 페이지 cover
      cover: coverUrl ? { type: "external", external: { url: coverUrl } } : undefined,
      properties,
    });

    return res.status(200).json({
      ok: true,
      pageId: created.id,
      createdOptions, // ✅ 자동 생성된 옵션 목록 (확인용)
      saved: {
        title,
        url: !!urlValue,
        cover: !!coverUrl,
        author: !!authorName,
        publisher: !!publisherName,
        rating: rating != null,
        genre: safeGenre,
        keywords: safeKeywords,
        guide: !!guideText.trim(),
        description: !!description.trim(),
        isAdult,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error", details: e?.body || null });
  }
};
