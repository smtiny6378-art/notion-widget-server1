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

  // ✅ 저장용 필드 (searchRidi가 내려주는 key들)
  const authorName = (body?.authorName ?? body?.author ?? "").toString().trim();
  const publisherName = (body?.publisherName ?? body?.publisher ?? "").toString().trim();
  const rating = toNumberSafe(body?.rating);

  const genreArr = normalizeArray(body?.genre);
  const keywordsArr = normalizeArray(body?.keywords ?? body?.tags); // tags를 키워드로 사용
  const guideText = (body?.guide ?? body?.romanceGuide ?? "").toString();
  const description = (body?.description ?? body?.meta ?? "").toString(); // meta(구버전)도 fallback

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ error: "NOTION_DB_ID is missing" });

    // ✅ DB 스키마 읽어서 multi-select 옵션 존재 여부 확인
    const db = await notion.databases.retrieve({ database_id: databaseId });
    const props = db?.properties || {};

    // ---- 네 DB 속성명(정확히 고정) ----
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

    // 성인작이면 키워드에 "19" 옵션이 있을 때만 추가
    const keywordCandidates = isAdult ? [...keywordsArr, "19"] : keywordsArr;

    const safeGenre = props[GENRE_PROP]?.type === "multi_select"
      ? (() => {
          const allowed = new Set((props[GENRE_PROP].multi_select.options || []).map(o => o.name));
          return genreArr.filter(n => allowed.has(n));
        })()
      : [];

    const safeKeywords = props[KEYWORDS_PROP]?.type === "multi_select"
      ? (() => {
          const allowed = new Set((props[KEYWORDS_PROP].multi_select.options || []).map(o => o.name));
          return keywordCandidates.filter(n => allowed.has(n));
        })()
      : [];

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

      // DB 속성 "표지"(Files)에도 저장
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
      skippedBecauseOptionMissing: {
        genre: genreArr.filter(x => !safeGenre.includes(x)),
        keywords: keywordCandidates.filter(x => !safeKeywords.includes(x)),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error", details: e?.body || null });
  }
};
