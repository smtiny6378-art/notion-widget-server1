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

// Notion URL 속성은 "" 금지 → null 또는 아예 속성 생략
function toNotionUrlValue(v) {
  const s = cleanText(v);
  if (!s) return null;
  return s;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

// 북마클릿(payload) ↔ 서버 코드 사이 필드명 차이를 흡수해서 표준화
function normalizePayload(p) {
  const title = cleanText(p.title || p.name || p.bookTitle || "");
  const platform = cleanText(p.platform || "");

  // 북마클릿은 url/link 둘 다 넣는 경우가 있음
  const url = cleanText(p.url || p.link || "");

  const coverUrl = cleanText(p.coverUrl || p.cover || "");

  const isAdult = !!p.isAdult;

  // 북마클릿: publisherName / 서버: publisher
  const authorName = cleanText(p.authorName || p.author || "");
  const publisher = cleanText(p.publisher || p.publisherName || "");

  // 장르: 배열로 오기도, 문자열로 오기도
  const genre = Array.isArray(p.genre)
    ? uniq(p.genre.map(cleanText)).filter(Boolean)
    : (cleanText(p.genre) ? [cleanText(p.genre)] : []);

  // 키워드: tags / keywords / keywords1~3 등 다양
  const mergedKeywords = uniq([
    ...(Array.isArray(p.keywords) ? p.keywords : []),
    ...(Array.isArray(p.tags) ? p.tags : []),
    ...(Array.isArray(p.keywords1) ? p.keywords1 : []),
    ...(Array.isArray(p.keywords2) ? p.keywords2 : []),
    ...(Array.isArray(p.keywords3) ? p.keywords3 : []),
  ].map(cleanText))
    // “19” 관련 제거(네 북마클릿과 동일 방침 유지)
    .filter(k => k && !k.includes("19"));

  // 본문: 북마클릿은 description/guide, 서버는 desc/romanceGuide
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
    genre,
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
    장르: {
      multi_select: (data.genre || []).map((g) => ({ name: g })),
    },
    키워드: {
      multi_select: (data.keywords || []).map((k) => ({ name: k })),
    },
  };

  // ✅ URL은 "" 보내면 바로 400 터짐 → null 또는 아예 생략
  const urlValue = toNotionUrlValue(data.url);
  if (urlValue !== null) {
    props.URL = { url: urlValue };
  }
  // url이 비면 props.URL 자체를 넣지 않음(가장 안전)

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

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // ✅ 북마클릿 2차 시도: {items:[payload]} 배치형도 지원
    const items = Array.isArray(body?.items) ? body.items : [body];

    const results = [];
    for (const raw of items) {
      const data = normalizePayload(raw || {});
      const pageId = await createOnePage(data);
      results.push({ ok: true, pageId });
    }

    // 단건이면 기존 형식 유지
    if (!Array.isArray(body?.items)) {
      return res.json({ ok: true, pageId: results[0].pageId });
    }
    // 배치면 배치 형식
    return res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
