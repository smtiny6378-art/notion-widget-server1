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

async function ensureMultiSelectOptions(databaseId, dbProps, propName, values) {
  if (!values || values.length === 0) return { added: [] };

  const prop = dbProps[propName];
  if (!prop || prop.type !== "multi_select") return { added: [] };

  const existingOptions = prop.multi_select?.options || [];
  const existing = new Set(existingOptions.map(o => o.name));
  const need = Array.from(new Set(values)).filter(v => v && !existing.has(v));

  if (need.length === 0) return { added: [] };

  const newOptions = [
    ...existingOptions.map(o => ({ name: o.name })), // color 생략 가능
    ...need.map(name => ({ name })),
  ];

  await notion.databases.update({
    database_id: databaseId,
    properties: {
      [propName]: { multi_select: { options: newOptions } },
    },
  });

  return { added: need };
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

  // ✅ 디버깅용(필요하면 잠깐 켜고 확인)
  const debug = body?.debug === true;

  const title = body?.title?.toString().trim();
  if (!title) return res.status(400).json({ error: "title is required" });

  const urlValue = (body?.url ?? body?.link)?.toString?.().trim?.() || "";
  const coverUrl = body?.coverUrl?.toString().trim() || "";
  const isAdult = toBoolean(body?.isAdult);

  // searchRidi(v7)가 내려주는 키 기준
  const authorName = (body?.authorName ?? "").toString().trim();
  const publisherName = (body?.publisherName ?? "").toString().trim();
  const ratingNum = toNumberSafe(body?.rating);

  const genreArr = normalizeArray(body?.genre);
  const keywordsArr = normalizeArray(body?.keywords ?? body?.tags); // tags를 키워드로 사용
  const guideText = (body?.guide ?? body?.romanceGuide ?? "").toString();
  const description = (body?.description ?? body?.meta ?? "").toString();

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ error: "NOTION_DB_ID is missing" });

    // DB 스키마 읽기
    let db = await notion.databases.retrieve({ database_id: databaseId });
    let props = db?.properties || {};

    // ✅ 네 DB 속성명(고정)
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

    // 성인작이면 키워드에 19 추가
    const keywordCandidates = isAdult ? [...keywordsArr, "19"] : keywordsArr;

    // ✅ 옵션 자동 생성 (장르/키워드)
    const createdOptions = { genre: [], keywords: [] };

    if (genreArr.length && props[GENRE_PROP]?.type === "multi_select") {
      const r = await ensureMultiSelectOptions(databaseId, props, GENRE_PROP, genreArr);
      createdOptions.genre = r.added;
    }
    if (keywordCandidates.length && props[KEYWORDS_PROP]?.type === "multi_select") {
      const r = await ensureMultiSelectOptions(databaseId, props, KEYWORDS_PROP, keywordCandidates);
      createdOptions.keywords = r.added;
    }

    // 옵션을 추가했으면 최신 스키마 다시 읽기
    if (createdOptions.genre.length || createdOptions.keywords.length) {
      db = await notion.databases.retrieve({ database_id: databaseId });
      props = db?.properties || {};
    }

    // ✅ properties 구성: 타입이 다를 때도 가능한 fallback
    const properties = {
      [TITLE_PROP]: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
    };

    // URL
    if (urlValue && props[URL_PROP]) {
      if (props[URL_PROP].type === "url") properties[URL_PROP] = { url: urlValue };
      else if (props[URL_PROP].type === "rich_text") properties[URL_PROP] = { rich_text: toRichTextChunks(urlValue) };
    }

    // 표지(files)
    if (coverUrl && props[COVER_PROP]?.type === "files") {
      properties[COVER_PROP] = {
        files: [{ type: "external", name: "cover", external: { url: coverUrl } }],
      };
    }

    // 작가명(text=rich_text)
    if (authorName && props[AUTHOR_PROP]) {
      if (props[AUTHOR_PROP].type === "rich_text") properties[AUTHOR_PROP] = { rich_text: toRichTextChunks(authorName) };
      // 혹시 plain_text 타입은 없지만, 그래도 최대한 저장
    }

    // 출판사명(text=rich_text)
    if (publisherName && props[PUBLISHER_PROP]) {
      if (props[PUBLISHER_PROP].type === "rich_text") properties[PUBLISHER_PROP] = { rich_text: toRichTextChunks(publisherName) };
    }

    // 평점(number) — 만약 DB에서 평점이 number가 아니면 rich_text로라도 저장
    if (props[RATING_PROP]) {
      if (ratingNum != null && props[RATING_PROP].type === "number") {
        properties[RATING_PROP] = { number: ratingNum };
      } else if (ratingNum != null && props[RATING_PROP].type === "rich_text") {
        properties[RATING_PROP] = { rich_text: toRichTextChunks(String(ratingNum)) };
      }
    }

    // 장르(multi_select)
    if (genreArr.length && props[GENRE_PROP]?.type === "multi_select") {
      properties[GENRE_PROP] = { multi_select: genreArr.map(name => ({ name })) };
    }

    // 키워드(multi_select)
    if (keywordCandidates.length && props[KEYWORDS_PROP]?.type === "multi_select") {
      properties[KEYWORDS_PROP] = { multi_select: keywordCandidates.map(name => ({ name })) };
    }

    // 로맨스 가이드(text=rich_text)
    if (guideText.trim() && props[GUIDE_PROP]?.type === "rich_text") {
      properties[GUIDE_PROP] = { rich_text: toRichTextChunks(guideText) };
    }

    // 작품 소개(text=rich_text)
    if (description.trim() && props[DESC_PROP]?.type === "rich_text") {
      properties[DESC_PROP] = { rich_text: toRichTextChunks(description) };
    }

    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      // 갤러리 카드 표지: 페이지 cover
      cover: coverUrl ? { type: "external", external: { url: coverUrl } } : undefined,
      properties,
    });

    return res.status(200).json({
      ok: true,
      pageId: created.id,
      createdOptions,
      received: debug
        ? {
            title,
            urlValue,
            coverUrl,
            isAdult,
            authorName,
            publisherName,
            rating: body?.rating,
            ratingNum,
            genreArr,
            keywordsArr,
            keywordCandidates,
            guideLen: guideText?.length || 0,
            descLen: description?.length || 0,
          }
        : undefined,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error", details: e?.body || null });
  }
};
