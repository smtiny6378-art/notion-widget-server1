// api/addToNotion.js
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function setCors(res) {
  // ridibooks.com 같은 외부 사이트에서 호출하므로 CORS 허용 필요
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);

  // ✅ 프리플라이트(OPTIONS) 먼저 처리 (이거 안 하면 Failed to fetch가 자주 뜸)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const page = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DB_ID },
      properties: {
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
        URL: {
          url: data.url || "",
        },
      },
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

    return res.json({ ok: true, pageId: page.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
