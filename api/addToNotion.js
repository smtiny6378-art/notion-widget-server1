const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function toRichText(value) {
  const s = value == null ? "" : String(value).trim();
  if (!s) return [];
  // Notion 제한 대비(대략 2000자 내로)
  return [{ type: "text", text: { content: s.slice(0, 2000) } }];
}

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string") {
    return v.split(/[,|]/g).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function toBoolean(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "y" || s === "yes";
  }
  return false;
}

// multi-select 옵션을 "name"으로 넣으면, 옵션이 DB에 없을 때 Notion이 에러를 내는 경우가 있어
// 그래서 DB 옵션 목록을 읽고 "존재하는 것만" 넣도록 필터링
function filterToExistingOptions(dbMultiSelectProp, names) {
  const options = dbMultiSelectProp?.multi_select?.options || [];
  const allowed = new Set(options.map(o => o.name));
  return names.filter(n => allowed.has(n));
}

module.exports = async (req, res) => {
  // ✅ CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }

  // ---- 입력(너의 /api/searchRidi + 향후 확장까지) ----
  const title = body?.title?.toString().trim();
  const url = (body?.url ?? body?.link)?.toString?.().trim?.() || "";

  const coverUrl = body?.coverUrl?.toString().trim();

  // meta가 object로 오면, DB의 각 필드로 최대한 쪼개서 넣고
  // 없거나 형식이 다르면 body의 개별 필드값도 사용
  const meta = body?.meta;

  const platform = normalizeArray(body?.platform ?? meta?.platform);
  const genre = normalizeArray(body?.genre ?? meta?.genre);
  const keywords = normalizeArray(body?.keywords ?? body?.tags ?? meta?.keywords ?? meta?.tags);

  const rating = body?.rating ?? meta?.rating ?? "";
  const author = body?.author ?? body?.authorName ?? meta?.author ?? meta?.authorName ?? "";
  const publisher = body?.publisher ?? body?.publisherName ?? meta?.publisher ?? meta?.publisherName ?? "";
  const romanceGuide = body?.romanceGuide ?? meta?.romanceGuide ?? meta?.romance_guide ?? "";
  const description = body?.description ?? body?.intro ?? meta?.description ?? meta?.intro ?? "";

  const isAdult = toBoolean(body?.isAdult ?? meta?.isAdult);

  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ error: "NOTION_DB_ID is missing" });

    // ✅ DB 스키마/옵션 불러오기 (멀티셀렉트 옵션 필터링용)
    const db = await notion.databases.retrieve({ database_id: databaseId });
    const props = db.properties || {};

    // 멀티셀렉트 옵션들(존재하는 옵션만 넣기 위해)
    const 플랫폼Prop = props["플랫폼"];
    const 장르Prop = props["장르"];
    const 키워드Prop = props["키워드"];

    // 19 여부는 컬럼이 없으니, 키워드에 "19" 옵션이 있을 때만 자동으로 추가
    let finalKeywords = [...keywords];
    if (isAdult) finalKeywords.push("19");

    // 존재하는 옵션만 남기기 (옵션이 DB에 없으면 넣지 않음)
    const safePlatform = filterToExistingOptions(플랫폼Prop, platform);
    const safeGenre = filterToExistingOptions(장르Prop, genre);
    const safeKeywords = filterToExistingOptions(키워드Prop, finalKeywords);

    const properties = {
      // Title
      "제목": { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },

      // Multi-select
      ...(safePlatform.length
        ? { "플랫폼": { multi_select: safePlatform.map(name => ({ name })) } }
        : {}),

      ...(safeGenre.length
        ? { "장르": { multi_select: safeGenre.map(name => ({ name })) } }
        : {}),

      ...(safeKeywords.length
        ? { "키워드": { multi_select: safeKeywords.map(name => ({ name })) } }
        : {}),

      // Files (external)
      ...(coverUrl
        ? {
            "표지": {
              files: [
                {
                  type: "external",
                  name: "cover",
                  external: { url: coverUrl },
                },
              ],
            },
          }
        : {}),

      // URL
      ...(url ? { "url": { url } } : {}),

      // rich_text (DB에서 "text"라고 보이는 것들)
      ...(rating ? { "평점": { rich_text: toRichText(rating) } } : {}),
      ...(author ? { "작가명": { rich_text: toRichText(author) } } : {}),
      ...(publisher ? { "출판사명": { rich_text: toRichText(publisher) } } : {}),
      ...(romanceGuide ? { "로맨스 가이드": { rich_text: toRichText(romanceGuide) } } : {}),
      ...(description ? { "작품 소개": { rich_text: toRichText(description) } } : {}),
    };

    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });

    return res.status(200).json({
      ok: true,
      pageId: created.id,
      saved: {
        title,
        url: !!url,
        coverUrl: !!coverUrl,
        platform: safePlatform,
        genre: safeGenre,
        keywords: safeKeywords,
        isAdult,
      },
      skippedBecauseOptionMissing: {
        // 디버깅용: DB에 옵션이 없어서 들어가지 않은 값들
        platform: platform.filter(x => !safePlatform.includes(x)),
        genre: genre.filter(x => !safeGenre.includes(x)),
        keywords: finalKeywords.filter(x => !safeKeywords.includes(x)),
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || "Unknown error",
      details: e?.body || null,
    });
  }
};
