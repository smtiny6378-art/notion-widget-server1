// api/addToNotion.js
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  try {
    const data = req.body;

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
        ? {
            external: { url: data.coverUrl },
          }
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
            rich_text: [
              { text: { content: data.romanceGuide || "비어 있음" } },
            ],
          },
        },
      ],
    });

    res.json({ ok: true, pageId: page.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
