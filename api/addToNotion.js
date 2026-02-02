// api/addToNotion.js
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

/* ================= helpers ================= */

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

// rich_text (속성용) – 2000자 제한
function toRichTextChunks(value, chunkSize = 2000) {
  const s = value == null ? "" : String(value);
  const out = [];
  for (let i = 0; i < s.length; i += chunkSize) {
    const chunk = s.slice(i, i + chunkSize);
    if (chunk.trim()) out.push({ type: "text", text: { content: chunk } });
  }
  return out.slice(0, 100);
}

// 본문(children)용 – paragraph 블록으로 쪼개기
function toParagraphBlocks(text, chunkSize = 1800) {
  const s = String(text || "");
  const blocks = [];
  for (let i = 0; i < s.length; i += chunkSize) {
    const chunk = s.slice(i, i + chunkSize);
    if (!chunk.trim()) continue;
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: chunk } }],
      },
    });
  }
  return blocks;
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

function findPropByNameAndType(props, nameCandidates, type) {
  const set = new Set(nameCandidates.map(normName));
  for (const k of Object.keys(props)) {
    if (props[k]?.type === type && set.has(normName(k))) return k;
  }
  return null;
}

/* ================ handler ================= */

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {}
  }

  const title = body?.title?.trim();
  if (!title) return res.status(400).json({ ok: false, error: "title required" });

  const urlValue = body?.url || body?.link || "";
  const coverUrl = body?.coverUrl || "";
  const isAdult = toBoolean(body?.isAdult);

  const authorName = body?.authorName || "";
  const publisherName = body?.publisherName || "";
  const ratingNum = toNumberSafe(body?.rating);

  const genreArr = normalizeArray(body?.genre);
  const tagsArr = normalizeArray(body?.tags);

  const description = body?.description || "";
  const guide = body?.guide || "";

  try {
    const databaseId = process.env.NOTION_DB_ID;
    const db = await notion.databases.retrieve({ database_id: databaseId });
    const props = db.properties;

    const titleProp = firstPropOfType(props, "title");
    const platformProp = findPropByNameAndType(props, ["플랫폼"], "select");
    const coverProp = findPropByNameAndType(props, ["표지"], "files");
    const ratingProp = findPropByNameAndType(props, ["평점"], "number");
    const authorProp = findPropByNameAndType(props, ["작가명"], "rich_text");
    const publisherProp = findPropByNameAndType(props, ["출판사명"], "rich_text");
    const genreProp = findPropByNameAndType(props, ["장르"], "select");
    const keywordsProp = findPropByNameAndType(props, ["키워드"], "multi_select");
    const urlProp = findPropByNameAndType(props, ["URL", "url"], "url");

    const keywordValues = isAdult
      ? Array.from(new Set([...tagsArr, "19"]))
      : tagsArr;

    const properties = {
      [titleProp]: { title: [{ type: "text", text: { content: title } }] },
      ...(platformProp ? { [platformProp]: { select: { name: "RIDI" } } } : {}),
      ...(urlProp && urlValue ? { [urlProp]: { url: urlValue } } : {}),
      ...(ratingProp && ratingNum != null ? { [ratingProp]: { number: ratingNum } } : {}),
      ...(authorProp && authorName ? { [authorProp]: { rich_text: toRichTextChunks(authorName) } } : {}),
      ...(publisherProp && publisherName ? { [publisherProp]: { rich_text: toRichTextChunks(publisherName) } } : {}),
      ...(genreProp && genreArr[0] ? { [genreProp]: { select: { name: genreArr[0] } } } : {}),
      ...(keywordsProp && keywordValues.length
        ? { [keywordsProp]: { multi_select: keywordValues.map(name => ({ name })) } }
        : {}),
      ...(coverProp && coverUrl
        ? { [coverProp]: { files: [{ type: "external", name: "cover", external: { url: coverUrl } }] } }
        : {}),
    };

    /* ===== 본문 children ===== */
    const children = [];

    if (description.trim()) {
      children.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "📘 작품 소개" } }] },
      });
      children.push(...toParagraphBlocks(description));
    }

    if (guide.trim()) {
      children.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "💕 로맨스 가이드" } }] },
      });
      children.push(...toParagraphBlocks(guide));
    }

    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      cover: coverUrl ? { type: "external", external: { url: coverUrl } } : undefined,
      properties,
      children,
    });

    return res.status(200).json({
      ok: true,
      pageId: created.id,
      bodyInserted: {
        description: Boolean(description),
        guide: Boolean(guide),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || "Unknown error",
    });
  }
};
