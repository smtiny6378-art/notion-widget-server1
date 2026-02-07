// api/addToNotion.js
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toNotionUrlValue(v) {
  const s = cleanText(v);
  if (!s) return null; // "" 금지
  return s;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function normalizePayload(p) {
  const title = cleanText(p.title || p.name || p.bookTitle || "");
  const platform = cleanText(p.platform || "");
  const url = cleanText(p.url || p.link || "");
  const coverUrl = cleanText(p.coverUrl || p.cover || "");
  const isAdult = !!p.isAdult;

  const authorName = cleanText(p.authorName || p.author || "");
  const publisher = cleanText(p.publisher || p.publisherName || "");

  // 장르는 "단일 select"로 보낼 1개만 고르기
  const genreList = Array.isArray(p.genre)
    ? uniq(p.genre.map(cleanText)).filter(Boolean)
    : (cleanText(p.genre) ? [cleanText(p.genre)] : []);
  const genreOne = genreList[0] || "";

  const mergedKeywords = uniq([
    ...(Array.isArray(p.keywords) ? p.keywords : []),
    ...(Array.isArray(p.tags) ? p.tags : []),
    ...(Array.isArray(p.keywords1) ? p.keywords1 : []),
    ...(Array.isArray(p.keywords2) ? p.keywords2 : []),
    ...(Array.isArray(p.keywords3) ? p.keywords3 : []),
  ].map(cleanText))
    .filter(k => k && !k.includes("19"));

  const desc = cleanText(p.desc || p.description || "");
  const romanceGuide = cleanText(p.romanceGuide || p.guide || "");

  return {
    title,
    platform,
    url,
    coverUrl,
    isAdult,
    authorName,
    publisher,
    genreOne,
    keywords: mergedKeywords,
    desc,
    romanceGuide,
  };
}

async function createOnePage(data) {
  const props = {
    제목: {
      title: [{ text: { content: data.title || "" } }],
    },
    플랫폼: {
      select: { name: data.platform || "RIDI" },
    },
    작가명: {
      rich_text: [{ text: { content: data.authorName || "" } }],
    },
    출판사명: {
      rich_text: [{ text: { content: data.publisher || "" } }],
    },

    // ✅ 장르가 "select" 타입이면 이렇게 보내야 함
    장르: data.genreOne
      ? { select: { name: data.genreOne } }
      : { select: null },

    키워드: {
      multi_select: (data.keywords || []).map((k) => ({ name: k })),
    },
  };

  const urlValue = toNotionUrlValue(data.url);
  if (urlValue !== null) {
    props.URL = { url: urlValue };
  }

  const page = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DB_ID },
    properties: props,
    cover: data.coverUrl
      ? { external: { url: data.coverUrl } }
      : undefined,
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "작품 소개" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: data.desc || "비어 있음" } }],
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "로맨스 가이드" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: data.romanceGuide || "비어 있음" } }],
        },
      },
    ],
  });

  return page.id;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const items = Array.isArray(body?.items) ? body.items : [body];

    const results = [];
    for (const raw of items) {
      const data = normalizePayload(raw || {});
      const pageId = await createOnePage(data);
      results.push({ ok: true, pageId });
    }

    if (!Array.isArray(body?.items)) {
      return res.json({ ok: true, pageId: results[0].pageId });
    }
    return res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
