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
  // 노션 rich_text는 최대 100개 조각 제한이 있어 안전장치
  return out.slice(0, 100);
}

function toNumberSafe(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// 이름 비교를 느슨하게(공백/대소문자/특수문자 차이 흡수)
function normName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·:：\-–—_]/g, "");
}

function findPropByNameAndType(props, nameCandidates, typeCandidates) {
  const candSet = new Set(nameCandidates.map(normName));
  const typeSet = new Set(Array.isArray(typeCandidates) ? typeCandidates : [typeCandidates]);

  for (const key of Object.keys(props)) {
    const p = props[key];
    if (!p) continue;
    if (!typeSet.has(p.type)) continue;
    if (candSet.has(normName(key))) return key;
  }
  return null;
}

function firstPropOfType(props, type) {
  return Object.keys(props).find(k => props[k]?.type === type) || null;
}

// ✅ select/multi_select 옵션 자동 생성
async function ensureSelectLikeOptions(databaseId, dbProps, propName, values) {
  if (!values || values.length === 0) return { added: [] };

  const prop = dbProps[propName];
  if (!prop) return { added: [] };

  const type = prop.type;
  if (type !== "multi_select" && type !== "select") return { added: [] };

  const existingOptions =
    type === "multi_select" ? (prop.multi_select?.options || []) : (prop.select?.options || []);

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
      [propName]:
        type === "multi_select"
          ? { multi_select: { options: newOptions } }
          : { select: { options: newOptions } },
    },
  });

  return { added: need };
}

// ✅ select/multi_select 값 설정
function setSelectLikeValue(props, propName, values) {
  const prop = props[propName];
  if (!prop) return null;

  if (prop.type === "multi_select") {
    const arr = normalizeArray(values);
    if (!arr.length) return null;
    return { multi_select: arr.map(name => ({ name })) };
  }

  if (prop.type === "select") {
    const arr = normalizeArray(values);
    const one = arr[0];
    if (!one) return null;
    return { select: { name: one } };
  }

  return null;
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
  const tagsArr = normalizeArray(body?.tags);
  const guideText = (body?.guide ?? body?.romanceGuide ?? "").toString();
  const description = (body?.description ?? body?.meta ?? "").toString();

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ ok: false, error: "NOTION_DB_ID is missing" });

    // DB 스키마 읽기
    let db = await notion.databases.retrieve({ database_id: databaseId });
    let props = db?.properties || {};

    // ✅ 속성명 자동 매핑(이름 조금 달라도 찾음 / select도 지원)
    const titleProp =
      findPropByNameAndType(props, ["제목", "title", "name", "이름"], "title") ||
      firstPropOfType(props, "title");

    const platformProp =
      findPropByNameAndType(props, ["플랫폼", "platform"], ["multi_select", "select"]) ||
      null;

    const coverProp =
      findPropByNameAndType(props, ["표지", "표지1", "표지 1", "커버", "cover", "이미지"], "files") ||
      firstPropOfType(props, "files");

    const ratingProp =
      findPropByNameAndType(props, ["평점", "평점1", "평점 1", "rating", "별점"], "number") ||
      firstPropOfType(props, "number");

    const authorProp =
      findPropByNameAndType(props, ["작가명", "작가", "author"], "rich_text") ||
      null;

    const publisherProp =
      findPropByNameAndType(props, ["출판사명", "출판사", "publisher"], "rich_text") ||
      null;

    const genreProp =
      findPropByNameAndType(props, ["장르", "genre"], ["multi_select", "select"]) ||
      null;

    const keywordsProp =
      findPropByNameAndType(props, ["키워드", "태그", "keywords"], ["multi_select", "select"]) ||
      null;

    const urlProp =
      findPropByNameAndType(props, ["url", "URL", "링크", "link", "주소"], "url") ||
      firstPropOfType(props, "url");

    const guideProp =
      findPropByNameAndType(props, ["로맨스가이드", "로맨스 가이드", "가이드", "guide"], "rich_text") ||
      null;

    const descProp =
      findPropByNameAndType(props, ["작품소개", "작품 소개", "소개", "description"], "rich_text") ||
      null;

    if (!titleProp) {
      return res.status(500).json({
        ok: false,
        error: "No Title property found in DB",
        availableProperties: Object.keys(props),
      });
    }

    // ✅ 넣을 값 준비
    const platformValues = ["RIDI"];
    const keywordCandidates = isAdult ? [...tagsArr, "19"] : tagsArr;

    // ✅ 옵션 자동 생성(select/multi_select 둘 다)
    const createdOptions = { platform: [], genre: [], keywords: [] };

    if (platformProp) {
      const r = await ensureSelectLikeOptions(databaseId, props, platformProp, platformValues);
      createdOptions.platform = r.added;
    }
    if (genreProp && genreArr.length) {
      const r = await ensureSelectLikeOptions(databaseId, props, genreProp, genreArr);
      createdOptions.genre = r.added;
    }
    if (keywordsProp && keywordCandidates.length) {
      const r = await ensureSelectLikeOptions(databaseId, props, keywordsProp, keywordCandidates);
      createdOptions.keywords = r.added;
    }

    // 옵션을 추가했으면 최신 스키마 다시 읽기
    if (createdOptions.platform.length || createdOptions.genre.length || createdOptions.keywords.length) {
      db = await notion.databases.retrieve({ database_id: databaseId });
      props = db?.properties || {};
    }

    // ✅ properties 구성
    const properties = {
      [titleProp]: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
    };

    // 플랫폼(select or multi_select)
    if (platformProp) {
      const v = setSelectLikeValue(props, platformProp, platformValues);
      if (v) properties[platformProp] = v;
    }

    // URL
    if (urlProp && props[urlProp]?.type === "url" && urlValue) {
      properties[urlProp] = { url: urlValue };
    }

    // 표지(files)
    if (coverProp && props[coverProp]?.type === "files" && coverUrl) {
      properties[coverProp] = {
        files: [{ type: "external", name: "cover", external: { url: coverUrl } }],
      };
    }

    // 평점(number)
    if (ratingProp && props[ratingProp]?.type === "number" && ratingNum != null) {
      properties[ratingProp] = { number: ratingNum };
    }

    // 작가명/출판사명
    if (authorProp && props[authorProp]?.type === "rich_text" && authorName) {
      properties[authorProp] = { rich_text: toRichTextChunks(authorName) };
    }
    if (publisherProp && props[publisherProp]?.type === "rich_text" && publisherName) {
      properties[publisherProp] = { rich_text: toRichTextChunks(publisherName) };
    }

    // 장르(select or multi_select) — 지금은 searchRidi가 genre를 못 뽑아서 비어있을 수 있음
    if (genreProp && genreArr.length) {
      const v = setSelectLikeValue(props, genreProp, genreArr);
      if (v) properties[genreProp] = v;
    }

    // 키워드(select or multi_select)
    if (keywordsProp && keywordCandidates.length) {
      const v = setSelectLikeValue(props, keywordsProp, keywordCandidates);
      if (v) properties[keywordsProp] = v;
    }

    // 가이드/작품소개 (rich_text)
    if (guideProp && props[guideProp]?.type === "rich_text" && guideText.trim()) {
      properties[guideProp] = { rich_text: toRichTextChunks(guideText) };
    }
    if (descProp && props[descProp]?.type === "rich_text" && description.trim()) {
      properties[descProp] = { rich_text: toRichTextChunks(description) };
    }

    const created = await notion.pages.create({
      parent: { database_id: databaseId },
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
