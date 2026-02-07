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

function uniq(arr) {
  return Array.from(new Set((arr || []).map(cleanText).filter(Boolean)));
}

function toUrlOrNull(v) {
  const s = cleanText(v);
  return s ? s : null; // URL "" 금지
}

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

function normalizePayload(p) {
  const title = cleanText(p.title || p.name || "");
  const platform = cleanText(p.platform || "RIDI");
  const url = cleanText(p.url || p.link || "");
  const isAdult = !!p.isAdult;

  const coverUrl = isAdult ? "" : cleanText(p.coverUrl || p.cover || "");

  const author = cleanText(p.authorName || p.author || "");
  const publisher = cleanText(p.publisherName || p.publisher || "");

  const genreList = Array.isArray(p.genre)
    ? uniq(p.genre)
    : (cleanText(p.genre) ? [cleanText(p.genre)] : []);
  const genre = genreList[0] || "";

  const k1 = remove19(uniq(Array.isArray(p.keywords1) ? p.keywords1 : []));
  const k2 = remove19(uniq(Array.isArray(p.keywords2) ? p.keywords2 : []));
  const k3 = remove19(uniq(Array.isArray(p.keywords3) ? p.keywords3 : []));

  const tags = remove19(uniq(Array.isArray(p.tags) ? p.tags : []));
  const keyword1 = k1.length ? k1 : tags;
  const keyword2 = k2;
  const keyword3 = k3;

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
  const urlValue = toUrlOrNull(normalized.url);

  const properties = {
    Title: {
      title: [{ text: { content: normalized.title || "" } }],
    },
    Platform: {
      select: { name: normalized.platform || "RIDI" },
    },
    Author: {
      rich_text: normalized.author ? [{ text: { content: normalized.author } }] : [],
    },
    Publisher: {
      rich_text: normalized.publisher ? [{ text: { content: normalized.publisher } }] : [],
    },
    Genre: normalized.genre ? { select: { name: normalized.genre } } : { select: null },

    "Keyword(1)": {
      multi_select: (normalized.keyword1 || []).map((k) => ({ name: k })),
    },
    "Keyword(2)": {
      multi_select: (normalized.keyword2 || []).map((k) => ({ name: k })),
    },
    "Keyword(3)": {
      multi_select: (normalized.keyword3 || []).map((k) => ({ name: k })),
    },

    URL: urlValue === null ? { url: null } : { url: urlValue },

    가이드: {
      rich_text: normalized.guide ? [{ text: { content: normalized.guide } }] : [],
    },
    "작품 소개": {
      rich_text: normalized.desc ? [{ text: { content: normalized.desc } }] : [],
    },

    Cover: { files: toExternalFiles(normalized.coverUrl) },
  };

  const page = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DB_ID },
    properties,
    cover: normalized.coverUrl ? { external: { url: normalized.coverUrl } } : undefined,
  });

  return page.id;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(body) : req.body;
    const items = Array.isArray(body?.items) ? body.items : [body];

    const results = [];
    for (const raw of items) {
      const normalized = normalizePayload(raw || {});
      const pageId = await createOnePage(normalized);
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
