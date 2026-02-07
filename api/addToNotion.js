// api/addToNotion.js
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

/**
 * 최종 Notion DB 스키마(사용자 제공)
 * - Title (title)
 * - Platform (select)
 * - Cover (files)
 * - Author (rich-text)
 * - Publisher (rich-text)
 * - Genre (select)
 * - Keyword(1) (multi-select)
 * - Keyword(2) (multi-select)
 * - Keyword(3) (multi-select)
 * - URL (url)
 * - 가이드 (rich-text)
 * - 작품 소개 (rich-text)
 */

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map(cleanText).filter(Boolean)));
}

// Notion URL 속성은 "" 금지 → null로 보내거나 아예 넣지 않기
function toUrlOrNull(v) {
  const s = cleanText(v);
  return s ? s : null;
}

// Cover(files)용 external 파일 1개 만들기
function toExternalFiles(url) {
  const u = cleanText(url);
  if (!u) return [];
  return [
    {
      name: "cover",
      type: "external",
      external: { url: u },
    },
  ];
}

function remove19(arr) {
  return (arr || []).filter((k) => k && !String(k).includes("19"));
}

/**
 * 북마클릿 payload를 이 서버가 쓰는 "최종 DB용 표준 데이터"로 변환
 * (북마클릿 코드 기준 필드명: title, platform, url/link, coverUrl, authorName, publisherName, genre, keywords1~3, tags, description, guide, isAdult)
 */
function normalizePayload(p) {
  const title = cleanText(p.title || p.name || "");
  const platform = cleanText(p.platform || "RIDI");

  const url = cleanText(p.url || p.link || "");
  const isAdult = !!p.isAdult;

  // 성인 작품이면 커버를 비우는 정책(원하면 여기서 바꿀 수 있음)
  const coverUrl = isAdult ? "" : cleanText(p.coverUrl || p.cover || "");

  const author = cleanText(p.authorName || p.author || "");
  const publisher = cleanText(p.publisherName || p.publisher || "");

  // Genre는 최종 DB에서 select(단일)
  const genreList = Array.isArray(p.genre)
    ? uniq(p.genre)
    : (cleanText(p.genre) ? [cleanText(p.genre)] : []);
  const genre = genreList[0] || "";

  // 키워드 1~3은 multi-select
  const k1 = remove19(uniq(Array.isArray(p.keywords1) ? p.keywords1 : []));
  const k2 = remove19(uniq(Array.isArray(p.keywords2) ? p.keywords2 : []));
  const k3 = remove19(uniq(Array.isArray(p.keywords3) ? p.keywords3 : []));

  // 북마클릿에서 tags만 채우는 경우 대비: Keyword(1)에 넣기
  const tags = remove19(uniq(Array.isArray(p.tags) ? p.tags : []));
  const keyword1 = k1.length ? k1 : tags;
  const keyword2 = k2;
  const keyword3 = k3;

  // 본문
  const guide = cleanText(p.guide || p.romanceGuide || "");
  const desc = cleanText(p.description || p.desc || "");

  return {
    title,
    platform,
    url,
    coverUrl,
    author,
    publisher,
    genre,
    keyword1,
    keyword2,
    keyword3,
    guide,
    desc,
  };
}

async function createOnePage(normalized) {
  // ✅ URL은 "" 보내면 Notion이 400으로 거절함 → null 또는 속성 생략
  const urlValue = toUrlOrNull(normalized.url);

  const properties = {
    // Title (title)
    Title: {
      title: [{ text: { content: normalized.title || "" } }],
    },

    // Platform (select)
    Platform: {
      select: { name: normalized.platform || "RIDI" },
    },

    // Author (rich-text)
    Author: {
      rich_text: normalized.author
        ? [{ text: { content: normalized.author } }]
        : [],
    },

    // Publisher (rich-text)
    Publisher: {
      rich_text: normalized.publisher
        ? [{ text: { content: normalized.publisher } }]
        : [],
    },

    // Genre (select)
    Genre: normalized.genre
      ? { select: { name: normalized.genre } }
      : { select: null },

    // Keyword(1~3) (multi-select)
    "Keyword(1)": {
      multi_select: (normalized.keyword1 || []).map((k) => ({ name: k })),
    },
    "Keyword(2)": {
      multi_select: (normalized.keyword2 || []).map((k) => ({ name: k })),
    },
    "Keyword(3)": {
      multi_select: (normalized.keyword3 || []).map((k) => ({ name: k })),
    },

    // 가이드 (rich-text)
    가이드: {
      rich_text: normalized.guide ? [{ text: { content: normalized.guide } }] : [],
    },

    // 작품 소개 (rich-text)
    "작품 소개": {
      rich_text: normalized.desc ? [{ text: { content: normalized.desc } }] : [],
    },
  };

  // URL (url) — 비었으면 null로
  if (urlValue === null) {
    properties.URL = { url: null };
  } else {
    properties.URL = { url: urlValue };
  }

  // Cover (files) — DB 속성 Cover(files)에 넣기
  properties.Cover = { files: toExternalFiles(normalized.coverUrl) };

  const page = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DB_ID },
    properties,
    // 페이지 상단 cover도 같이 설정(원치 않으면 이 줄 지워도 됨)
    cover: normalized.coverUrl ? { external: { url: normalized.coverUrl } } : undefined,
  });

  return page.id;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // 북마클릿 2차 시도: {items:[payload]} 지원
    const items = Array.isArray(body?.items) ? body.items : [body];

    const results = [];
    for (const raw of items) {
      const normalized = normalizePayload(raw || {});
      const pageId = await createOnePage(normalized);
      results.push({ ok: true, pageId });
    }

    // 단건이면 {ok:true,pageId}
    if (!Array.isArray(body?.items)) {
      return res.json({ ok: true, pageId: results[0].pageId });
    }
    // 배치면 {ok:true,results:[...]}
    return res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
