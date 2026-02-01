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

// 후보 이름 중 DB에 존재하고 타입까지 맞으면 그 속성명 반환
function pickPropName(props, candidates, type) {
  for (const name of candidates) {
    if (props[name] && (!type || props[name].type === type)) return name;
  }
  return null;
}

// 같은 타입의 첫 속성명(최후의 보험)
function firstPropOfType(props, type) {
  return Object.keys(props).find(k => props[k].type === type) || null;
}

// multi-select 옵션 없으면 자동 생성
async function ensureMultiSelectOptions(databaseId, dbProps, propName, values) {
  if (!values || values.length === 0) return { added: [] };

  const prop = dbProps[propName];
  if (!prop || prop.type !== "multi_select") return { added: [] };

  const existingOptions = prop.multi_select?.options || [];
  const existing = new Set(existingOptions.map(o => o.name));
  const need = Array.from(new Set(values)).filter(v => v && !existing.has(v));

  if (need.length === 0) return { added: [] };

  const newOptions = [
    ...existingOptions.map(o => ({ name: o.name })),
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
    try { body = JSON.parse(body); } catch {}
  }

  const title = body?.title?.toString().trim();
  if (!title) return res.status(400).json({ ok: false, error: "title is required" });

  const urlValue = (body?.url ?? body?.link)?.toString?.().trim?.() || "";
  const coverUrl = body?.coverUrl?.toString().trim() || "";
  const isAdult = toBoolean(body?.isAdult);

  const authorName = (body?.authorName ?? "").toString().trim();
  const publisherName = (body?.publisherName ?? "").toString().trim();
  const ratingNum = toNumberSafe(body?.rating);

  const genreArr = normalizeArray(body?.genre);
  const tagsArr = normalizeArray(body?.tags); // 키워드로 저장
  const guideText = (body?.guide ?? body?.romanceGuide ?? "").toString();
  const description = (body?.description ?? body?.meta ?? "").toString();

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ ok: false, error: "NOTION_DB_ID is missing" });

    // DB 스키마 읽기
    let db = await notion.databases.retrieve({ database_id: databaseId });
    let props = db?.properties || {};

    // ✅ 실제 DB 속성명 자동 매핑(‘표지 1’, ‘평점 1’, ‘URL’ 같은 케이스 포함)
    const titleProp = pickPropName(props, ["제목", "Title", "이름", "Name"], "title") || firstPropOfType(props, "title");

    const platformProp =
      pickPropName(props, ["플랫폼", "Platform"], "multi_select") ||
      null;

    const coverProp =
      pickPropName(props, ["표지", "표지 1", "커버", "Cover", "cover", "이미지"], "files") ||
      firstPropOfType(props, "files");

    const ratingProp =
      pickPropName(props, ["평점", "평점 1", "별점", "Rating"], "number") ||
      firstPropOfType(props, "number");

    const authorProp =
      pickPropName(props, ["작가명", "작가", "Author"], "rich_text") ||
      null;

    const publisherProp =
      pickPropName(props, ["출판사명", "출판사", "Publisher"], "rich_text") ||
      null;

    const genreProp =
      pickPropName(props, ["장르", "Genre"], "multi_select") ||
      null;

    const keywordsProp =
      pickPropName(props, ["키워드", "태그", "Keywords"], "multi_select") ||
      null;

    const urlProp =
      pickPropName(props, ["url", "URL", "링크", "Link", "주소"], "url") ||
      firstPropOfType(props, "url");

    const guideProp =
      pickPropName(props, ["로맨스 가이드", "가이드", "Romance Guide"], "rich_text") ||
      null;

    const descProp =
      pickPropName(props, ["작품 소개", "작품소개", "소개", "Description"], "rich_text") ||
      null;

    if (!titleProp) {
      return res.status(500).json({
        ok: false,
        error: "No Title property found in DB",
        availableProperties: Object.keys(props),
      });
    }

    // ✅ multi-select에 넣을 값 준비
    // 플랫폼은 무조건 RIDI 넣기(옵션 없으면 생성)
    const platformValues = ["RIDI"];

    // 키워드는 tags + 성인일 때 '19'
    const keywordCandidates = isAdult ? [...tagsArr, "19"] : tagsArr;

    const createdOptions = { platform: [], genre: [], keywords: [] };

    // 옵션 자동 생성(플랫폼/장르/키워드)
    if (platformProp && props[platformProp]?.type === "multi_select") {
      const r = await ensureMultiSelectOptions(databaseId, props, platformProp, platformValues);
      createdOptions.platform = r.added;
    }
    if (genreProp && props[genreProp]?.type === "multi_select" && genreArr.length) {
      const r = await ensureMultiSelectOptions(databaseId, props, genreProp, genreArr);
      createdOptions.genre = r.added;
    }
    if (keywordsProp && props[keywordsProp]?.type === "multi_select" && keywordCandidates.length) {
      const r = await ensureMultiSelectOptions(databaseId, props, keywordsProp, keywordCandidates);
      createdOptions.keywords = r.added;
    }

    // 옵션을 추가했으면 최신 스키마 다시 읽기(안전)
    if (createdOptions.platform.length || createdOptions.genre.length || createdOptions.keywords.length) {
      db = await notion.databases.retrieve({ database_id: databaseId });
      props = db?.properties || {};
    }

    // ✅ properties 구성
    const properties = {
      [titleProp]: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
    };

    if (platformProp && props[platformProp]?.type === "multi_select") {
      properties[platformProp] = { multi_select: platformValues.map(name => ({ name })) };
    }

    if (urlProp && props[urlProp]?.type === "url" && urlValue) {
      properties[urlProp] = { url: urlValue };
    }

    if (coverProp && props[coverProp]?.type === "files" && coverUrl) {
      properties[coverProp] = {
        files: [{ type: "external", name: "cover", external: { url: coverUrl } }],
      };
    }

    if (ratingProp && props[ratingProp]?.type === "number" && ratingNum != null) {
      properties[ratingProp] = { number: ratingNum };
    }

    if (authorProp && props[authorProp]?.type === "rich_text" && authorName) {
      properties[authorProp] = { rich_text: toRichTextChunks(authorName) };
    }

    if (publisherProp && props[publisherProp]?.type === "rich_text" && publisherName) {
      properties[publisherProp] = { rich_text: toRichTextChunks(publisherName) };
    }

    if (genreProp && props[genreProp]?.type === "multi_select" && genreArr.length) {
      properties[genreProp] = { multi_select: genreArr.map(name => ({ name })) };
    }

    if (keywordsProp && props[keywordsProp]?.type === "multi_select" && keywordCandidates.length) {
      properties[keywordsProp] = { multi_select: keywordCandidates.map(name => ({ name })) };
    }

    if (guideProp && props[guideProp]?.type === "rich_text" && guideText.trim()) {
      properties[guideProp] = { rich_text: toRichTextChunks(guideText) };
    }

    if (descProp && props[descProp]?.type === "rich_text" && description.trim()) {
      properties[descProp] = { rich_text: toRichTextChunks(description) };
    }

    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      // 갤러리 카드 표지: 페이지 커버
      cover: coverUrl ? { type: "external", external: { url: coverUrl } } : undefined,
      properties,
    });

    return res.status(200).json({
      ok: true,
      pageId: created.id,
      mapped: {
        titleProp, platformProp, coverProp, ratingProp, authorProp, publisherProp,
        genreProp, keywordsProp, urlProp, guideProp, descProp
      },
      createdOptions,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error", details: e?.body || null });
  }
};
