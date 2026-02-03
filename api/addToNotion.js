// api/addToNotion.js
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ---------------- helpers ----------------
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

function toNumberSafe(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ✅ 노션용 텍스트: 줄바꿈 유지 + 과다 줄바꿈 정리
function normalizeNotionText(v) {
  if (v == null) return "";
  return String(v)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ✅ rich_text를 2000자 단위로 쪼개서 전체 저장(줄바꿈은 유지됨)
function toRichTextChunks(value, chunkSize = 2000) {
  const s = value == null ? "" : String(value);
  const out = [];
  for (let i = 0; i < s.length; i += chunkSize) {
    const chunk = s.slice(i, i + chunkSize);
    // 내부 \n은 그대로, 빈 문자열만 방지
    if (chunk.trim()) out.push({ type: "text", text: { content: chunk } });
  }
  return out.slice(0, 100);
}

function normName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·:：\-–—_]/g, "");
}

function firstPropOfType(props, type) {
  return Object.keys(props).find(k => props[k]?.type === type) || null;
}

function findPropByNameAndType(props, nameCandidates, typeCandidates) {
  const candSet = new Set(nameCandidates.map(normName));
  const types = Array.isArray(typeCandidates) ? typeCandidates : [typeCandidates];
  const typeSet = new Set(types);

  for (const key of Object.keys(props)) {
    const p = props[key];
    if (!p) continue;
    if (!typeSet.has(p.type)) continue;
    if (candSet.has(normName(key))) return key;
  }
  return null;
}

// ✅ Select 옵션 자동 생성(플랫폼/장르)
async function ensureSelectOption(databaseId, dbProps, propName, value) {
  if (!value) return { added: [] };
  const prop = dbProps[propName];
  if (!prop || prop.type !== "select") return { added: [] };

  const existing = prop.select?.options || [];
  if (existing.some(o => o.name === value)) return { added: [] };

  const newOptions = [...existing.map(o => ({ name: o.name })), { name: value }];

  await notion.databases.update({
    database_id: databaseId,
    properties: { [propName]: { select: { options: newOptions } } },
  });

  return { added: [value] };
}

// ✅ Multi-select 옵션 자동 생성(키워드)
async function ensureMultiSelectOptions(databaseId, dbProps, propName, values) {
  const arr = normalizeArray(values);
  if (!arr.length) return { added: [] };

  const prop = dbProps[propName];
  if (!prop || prop.type !== "multi_select") return { added: [] };

  const existing = prop.multi_select?.options || [];
  const existingSet = new Set(existing.map(o => o.name));

  const need = Array.from(new Set(arr)).filter(v => v && !existingSet.has(v));
  if (!need.length) return { added: [] };

  const newOptions = [
    ...existing.map(o => ({ name: o.name })),
    ...need.map(name => ({ name })),
  ];

  await notion.databases.update({
    database_id: databaseId,
    properties: { [propName]: { multi_select: { options: newOptions } } },
  });

  return { added: need };
}

function setSelectValue(props, propName, value) {
  const prop = props[propName];
  if (!prop || prop.type !== "select") return null;
  if (!value) return null;
  return { select: { name: value } };
}

function setMultiSelectValue(props, propName, values) {
  const prop = props[propName];
  if (!prop || prop.type !== "multi_select") return null;

  const arr = Array.from(new Set(normalizeArray(values)));
  if (!arr.length) return null;

  return { multi_select: arr.map(name => ({ name })) };
}

// ---------------- handler ----------------
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

  // ✅ 줄바꿈 유지 텍스트
  const guideText = normalizeNotionText(body?.guide ?? body?.romanceGuide ?? "");
  const descText = normalizeNotionText(body?.description ?? body?.meta ?? "");

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ ok: false, error: "NOTION_DB_ID is missing" });

    // 스키마 읽기
    let db = await notion.databases.retrieve({ database_id: databaseId });
    let props = db?.properties || {};

    // ---- property mapping ----
    const titleProp =
      findPropByNameAndType(props, ["제목", "title", "name", "이름"], "title") ||
      firstPropOfType(props, "title");

    const platformProp =
      findPropByNameAndType(props, ["플랫폼", "platform"], "select") || null;

    const coverProp =
      findPropByNameAndType(props, ["표지", "커버", "cover", "이미지"], "files") ||
      firstPropOfType(props, "files");

    const ratingProp =
      findPropByNameAndType(props, ["평점", "rating", "별점"], "number") ||
      firstPropOfType(props, "number");

    const authorProp =
      findPropByNameAndType(props, ["작가명", "작가", "저자", "author"], "rich_text") || null;

    const publisherProp =
      findPropByNameAndType(props, ["출판사명", "출판사", "publisher"], "rich_text") || null;

    const genreProp =
      findPropByNameAndType(props, ["장르", "genre"], "select") || null;

    const keywordsProp =
      findPropByNameAndType(props, ["키워드", "태그", "keywords"], "multi_select") || null;

    const urlProp =
      findPropByNameAndType(props, ["url", "URL", "링크", "link", "주소"], "url") ||
      firstPropOfType(props, "url");

    const guideProp =
      findPropByNameAndType(props, ["로맨스 가이드", "로맨스가이드", "가이드", "guide"], "rich_text") || null;

    const descProp =
      findPropByNameAndType(props, ["작품 소개", "작품소개", "소개", "description"], "rich_text") || null;

    if (!titleProp) {
      return res.status(500).json({
        ok: false,
        error: "No Title property found in DB",
        availableProperties: Object.keys(props),
      });
    }

    // ---- 값 결정 ----
    const platformValue = "RIDI";
    const genreValue = genreArr[0] || "";

    const keywordValues = isAdult
      ? Array.from(new Set([...tagsArr, "19"]))
      : Array.from(new Set(tagsArr));

    // ---- 옵션 자동 생성 ----
    const createdOptions = { platform: [], genre: [], keywords: [] };

    if (platformProp) {
      const r = await ensureSelectOption(databaseId, props, platformProp, platformValue);
      createdOptions.platform = r.added;
    }

    if (genreProp && genreValue) {
      const r = await ensureSelectOption(databaseId, props, genreProp, genreValue);
      createdOptions.genre = r.added;
    }

    if (keywordsProp && keywordValues.length) {
      const r = await ensureMultiSelectOptions(databaseId, props, keywordsProp, keywordValues);
      createdOptions.keywords = r.added;
    }

    if (createdOptions.platform.length || createdOptions.genre.length || createdOptions.keywords.length) {
      db = await notion.databases.retrieve({ database_id: databaseId });
      props = db?.properties || {};
    }

    // ---- properties 구성 ----
    const properties = {
      [titleProp]: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
    };

    if (platformProp) {
      const v = setSelectValue(props, platformProp, platformValue);
      if (v) properties[platformProp] = v;
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

    if (genreProp && genreValue) {
      const v = setSelectValue(props, genreProp, genreValue);
      if (v) properties[genreProp] = v;
    }

    if (keywordsProp && keywordValues.length) {
      const v = setMultiSelectValue(props, keywordsProp, keywordValues);
      if (v) properties[keywordsProp] = v;
    }

    // ✅ 여기서 줄바꿈 포함 rich_text 저장
    if (guideProp && props[guideProp]?.type === "rich_text" && guideText.trim()) {
      properties[guideProp] = { rich_text: toRichTextChunks(guideText) };
    }

    if (descProp && props[descProp]?.type === "rich_text" && descText.trim()) {
      properties[descProp] = { rich_text: toRichTextChunks(descText) };
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
      usedValues: { platformValue, genreValue, keywordValues },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      details: e?.body || null,
    });
  }
};
