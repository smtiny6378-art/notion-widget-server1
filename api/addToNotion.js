// /api/addToNotion.js
const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  timeoutMs: Number(process.env.NOTION_TIMEOUT_MS || 120000),
});

// ------------------ retry ------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function withRetry(fn, { tries = 3, baseDelay = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "").toLowerCase();
      const retryable =
        msg.includes("timed out") ||
        msg.includes("timeout") ||
        e?.status === 429 ||
        (e?.status >= 500 && e?.status <= 599);
      if (!retryable || i === tries - 1) break;
      await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ------------------ helpers ------------------
function safeJsonBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
  return body || {};
}

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,|]/g).map((s) => s.trim()).filter(Boolean);
  return [];
}

function normalizeNotionText(v) {
  if (v == null) return "";
  return String(v).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// rich_text: 줄바꿈 유지 + 2000자 단위 + 최대 100블록
function toRichTextParagraphs(value, chunkSize = 2000) {
  const text = normalizeNotionText(value);
  if (!text) return [];
  const hasDouble = text.includes("\n\n");
  const splitRe = hasDouble ? /\n{2,}/g : /\n+/g;

  const paragraphs = text.split(splitRe).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const paraWithGap = i < paragraphs.length - 1 ? paragraphs[i] + "\n\n" : paragraphs[i];
    for (let j = 0; j < paraWithGap.length; j += chunkSize) {
      const chunk = paraWithGap.slice(j, j + chunkSize);
      if (chunk) out.push({ type: "text", text: { content: chunk } });
      if (out.length >= 100) break;
    }
    if (out.length >= 100) break;
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
  return Object.keys(props).find((k) => props[k]?.type === type) || null;
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
  return { multi_select: arr.map((name) => ({ name })) };
}

// ------------------ option auto create ------------------
// 장르(Genre)는 4개 고정이라 자동생성 금지
// 키워드(Keyword 1/2/3)와 플랫폼(Platform)은 자동생성 허용(저장 실패 방지)
const AUTO_CREATE_PLATFORM = true;
const AUTO_CREATE_KEYWORDS = true;
const AUTO_CREATE_GENRE = false;

async function ensureSelectOption(databaseId, dbProps, propName, value, allowCreate) {
  if (!allowCreate) return { added: [] };
  if (!value) return { added: [] };
  const prop = dbProps[propName];
  if (!prop || prop.type !== "select") return { added: [] };

  const existing = prop.select?.options || [];
  if (existing.some((o) => o.name === value)) return { added: [] };

  const newOptions = [...existing.map((o) => ({ name: o.name })), { name: value }];

  await withRetry(() =>
    notion.databases.update({
      database_id: databaseId,
      properties: { [propName]: { select: { options: newOptions } } },
    })
  );
  return { added: [value] };
}

async function ensureMultiSelectOptions(databaseId, dbProps, propName, values, allowCreate) {
  if (!allowCreate) return { added: [] };
  const arr = normalizeArray(values);
  if (!arr.length) return { added: [] };

  const prop = dbProps[propName];
  if (!prop || prop.type !== "multi_select") return { added: [] };

  const existing = prop.multi_select?.options || [];
  const existingSet = new Set(existing.map((o) => o.name));

  const need = Array.from(new Set(arr)).filter((v) => v && !existingSet.has(v));
  if (!need.length) return { added: [] };

  const newOptions = [
    ...existing.map((o) => ({ name: o.name })),
    ...need.map((name) => ({ name })),
  ];

  await withRetry(() =>
    notion.databases.update({
      database_id: databaseId,
      properties: { [propName]: { multi_select: { options: newOptions } } },
    })
  );
  return { added: need };
}

// ------------------ platform + rules ------------------
function inferSourcePlatform(url, bodyPlatform) {
  const p = String(bodyPlatform || "").trim();
  const u = String(url || "");

  if (p.includes("카카오웹툰")) return "카카오웹툰";
  if (p.includes("카카오페이지")) return "카카오페이지";
  if (p.toUpperCase() === "RIDI") return "RIDI";
  if (p.toUpperCase() === "KAKAO") return u.includes("webtoon.kakao.com") ? "카카오웹툰" : "카카오페이지";

  if (u.includes("webtoon.kakao.com")) return "카카오웹툰";
  if (u.includes("page.kakao.com")) return "카카오페이지";
  if (u.includes("ridibooks.com")) return "RIDI";
  return "";
}

function toNotionPlatformValue(sourcePlatform) {
  if (sourcePlatform === "카카오웹툰" || sourcePlatform === "카카오페이지") return "KAKAO";
  return "RIDI";
}

function titleFromKakaoUrl(url) {
  try {
    const u = String(url || "").trim();
    const m = u.match(/\/content\/([^/]+)\/(\d+)/);
    if (!m) return "";
    const slug = decodeURIComponent(m[1]);
    return slug.replace(/-/g, " ").trim();
  } catch { return ""; }
}

function cleanPublisher(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (s.includes("AI 매칭")) return "";
  if (s.includes("<")) return "";
  return s;
}

function stripWebtoonSuffix(title) {
  return String(title || "").replace(/\s*\|\s*카카오웹툰\s*$/g, "").trim();
}

// 카카오웹툰: [19세 완전판] 뒤에 1회만
function normalize19TagOnceForWebtoon(title, isAdult) {
  let t = stripWebtoonSuffix(String(title || "").trim());
  t = t.replace(/\[19세\s*완전판\]\s*/g, "").trim();
  if (isAdult) t = `${t} [19세 완전판]`.trim();
  return t;
}

// ------------------ genre mapping (4개 고정) ------------------
const ALLOWED_GENRES = new Set(["로맨스", "로맨스판타지", "BL", "판타지"]);

function mapGenreToAllowed(rawGenres) {
  const arr = normalizeArray(rawGenres).map((g) => String(g).replace(/\s+/g, "").trim()).filter(Boolean);
  const joined = arr.join(" ");

  // BL 우선
  if (arr.some((g) => g.toLowerCase() === "bl") || joined.toLowerCase().includes("bl")) return "BL";

  // 로맨스판타지(로판/로맨스판타지/로판 등)
  if (joined.includes("로맨스판타지") || joined.includes("로판") || (joined.includes("로맨스") && joined.includes("판타지"))) {
    return "로맨스판타지";
  }

  // 판타지
  if (joined.includes("판타지")) return "판타지";

  // 기본 로맨스
  return "로맨스";
}

// ------------------ keyword cleanup ------------------
function stripHash(s) {
  // "#키워드" / "##키워드" / "# 키워드" 같은 것들 제거
  return String(s || "").replace(/^#+\s*/g, "").trim();
}

// 모든 플랫폼: 키워드에서 19/성인 토큰 제거 + # 제거
function normalizeKeywords(values) {
  return Array.from(new Set(normalizeArray(values)))
    .map(stripHash)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((t) => {
      const n = String(t || "").replace(/\s+/g, "").toLowerCase();
      if (!n) return false;
      if (n === "19" || n === "19세" || n.includes("19세")) return false;
      if (n.includes("미만이용불가") || n.includes("성인") || n.includes("청소년이용불가")) return false;
      return true;
    });
}

// 장르에 따라 키워드 속성 선택
function pickKeywordPropByGenre(genreValue, keyword1Prop, keyword2Prop, keyword3Prop) {
  if (genreValue === "BL") return keyword2Prop || keyword1Prop || keyword3Prop || null;
  if (genreValue === "판타지") return keyword3Prop || keyword1Prop || keyword2Prop || null;
  // 로맨스 / 로맨스판타지
  return keyword1Prop || keyword2Prop || keyword3Prop || null;
}

// ------------------ core create ------------------
async function createOne(rawItem, ctx) {
  const {
    databaseId, props,
    titleProp, platformProp, coverProp,
    authorProp, publisherProp, genreProp,
    keyword1Prop, keyword2Prop, keyword3Prop,
    urlProp, guideProp, descProp,
  } = ctx;

  const body =
    (rawItem && rawItem.data && typeof rawItem.data === "object") ? rawItem.data : rawItem;

  const urlValue = (body?.url ?? body?.link)?.toString?.().trim?.() || "";

  // title
  let title = body?.title?.toString?.().trim?.() || "";
  if (!title && urlValue) title = titleFromKakaoUrl(urlValue);
  if (!title) return { ok: false, error: "title is required" };

  // source platform / notion platform
  const sourcePlatform = inferSourcePlatform(urlValue, body?.platform);
  const platformValue = toNotionPlatformValue(sourcePlatform);

  // adult
  const isAdult =
    body?.isAdult === true ||
    body?.adult === true ||
    body?.is19 === true ||
    String(body?.ageLimit || "").includes("19") ||
    String(body?.rating || "").includes("19");

  // title rules (kakao webtoon)
  if (sourcePlatform === "카카오웹툰") {
    title = normalize19TagOnceForWebtoon(title, isAdult);
  } else {
    title = stripWebtoonSuffix(title);
  }

  const coverUrl = body?.coverUrl?.toString?.().trim?.() || "";
  const authorName = (body?.authorName ?? body?.author ?? "").toString().trim();
  const publisherName = cleanPublisher(body?.publisherName ?? body?.publisher ?? "");

  // genre: 4개로 매핑
  const genreValue = mapGenreToAllowed(body?.genre);

  // keywords: # 제거 + 성인 토큰 제거
  const rawKeywords = body?.tags ?? body?.keywords ?? body?.keyword ?? [];
  const keywordValues = normalizeKeywords(rawKeywords);

  // genre 기반으로 저장할 키워드 속성 선택
  const keywordProp = pickKeywordPropByGenre(genreValue, keyword1Prop, keyword2Prop, keyword3Prop);

  const guideText = normalizeNotionText(body?.guide ?? body?.romanceGuide ?? "");
  const descText = normalizeNotionText(body?.description ?? body?.meta ?? body?.desc ?? "");

  // ---- option auto create ----
  const createdOptions = { platform: [], genre: [], keywords: [] };

  if (platformProp) {
    const r = await ensureSelectOption(databaseId, props, platformProp, platformValue, AUTO_CREATE_PLATFORM);
    createdOptions.platform = r.added;
  }

  // Genre는 4개 고정(자동생성 금지). 값도 4개 중 하나로만 매핑했음.
  if (genreProp && genreValue && ALLOWED_GENRES.has(genreValue)) {
    const r = await ensureSelectOption(databaseId, props, genreProp, genreValue, AUTO_CREATE_GENRE);
    createdOptions.genre = r.added;
  }

  if (keywordProp && keywordValues.length) {
    const r = await ensureMultiSelectOptions(databaseId, props, keywordProp, keywordValues, AUTO_CREATE_KEYWORDS);
    createdOptions.keywords = r.added;
  }

  // ---- properties ----
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

  if (authorProp && props[authorProp]?.type === "rich_text" && authorName) {
    properties[authorProp] = { rich_text: toRichTextParagraphs(authorName) };
  }

  if (publisherProp && props[publisherProp]?.type === "rich_text" && publisherName) {
    properties[publisherProp] = { rich_text: toRichTextParagraphs(publisherName) };
  }

  if (genreProp && genreValue && ALLOWED_GENRES.has(genreValue)) {
    const v = setSelectValue(props, genreProp, genreValue);
    if (v) properties[genreProp] = v;
  }

  if (keywordProp && keywordValues.length) {
    const v = setMultiSelectValue(props, keywordProp, keywordValues);
    if (v) properties[keywordProp] = v;
  }

  if (guideProp && props[guideProp]?.type === "rich_text" && guideText.trim()) {
    properties[guideProp] = { rich_text: toRichTextParagraphs(guideText) };
  }

  if (descProp && props[descProp]?.type === "rich_text" && descText.trim()) {
    properties[descProp] = { rich_text: toRichTextParagraphs(descText) };
  }

  const created = await withRetry(() =>
    notion.pages.create({
      parent: { database_id: databaseId },
      cover: coverUrl ? { type: "external", external: { url: coverUrl } } : undefined,
      properties,
    })
  );

  return {
    ok: true,
    pageId: created.id,
    title,
    url: urlValue,
    sourcePlatform,
    platformValue,
    genreValue,
    keywordPropUsed: keywordProp || null,
    keywordValues,
    isAdult,
    createdOptions,
  };
}

// ------------------ handler ------------------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const body = safeJsonBody(req);

  try {
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) {
      return res.status(500).json({ ok: false, error: "NOTION_DB_ID is missing" });
    }

    const db = await withRetry(() =>
      notion.databases.retrieve({ database_id: databaseId })
    );
    const props = db?.properties || {};

    // ✅ 네 DB 속성명 기준으로 우선 매핑
    const titleProp =
      findPropByNameAndType(props, ["Title", "제목", "title", "name"], "title") ||
      firstPropOfType(props, "title");

    const platformProp =
      findPropByNameAndType(props, ["Platform", "플랫폼", "platform"], "select") || null;

    const coverProp =
      findPropByNameAndType(props, ["Cover", "표지", "커버", "cover", "이미지"], "files") ||
      firstPropOfType(props, "files");

    // 별점 없음

    const authorProp =
      findPropByNameAndType(props, ["Author", "작가명", "작가", "저자", "author"], "rich_text") || null;

    const publisherProp =
      findPropByNameAndType(props, ["Publisher", "출판사명", "출판사", "publisher"], "rich_text") || null;

    const genreProp =
      findPropByNameAndType(props, ["Genre", "장르", "genre"], "select") || null;

    const keyword1Prop =
      findPropByNameAndType(props, ["Keyword(1)", "Keyword1", "키워드1"], "multi_select") || null;

    const keyword2Prop =
      findPropByNameAndType(props, ["Keyword(2)", "Keyword2", "키워드2"], "multi_select") || null;

    const keyword3Prop =
      findPropByNameAndType(props, ["Keyword(3)", "Keyword3", "키워드3"], "multi_select") || null;

    const urlProp =
      findPropByNameAndType(props, ["URL", "url", "링크", "link", "주소"], "url") ||
      firstPropOfType(props, "url");

    const guideProp =
      findPropByNameAndType(props, ["가이드", "Guide", "guide"], "rich_text") || null;

    const descProp =
      findPropByNameAndType(props, ["작품 소개", "Description", "소개", "description"], "rich_text") || null;

    if (!titleProp) {
      return res.status(500).json({
        ok: false,
        error: "No Title property found in DB",
        availableProperties: Object.keys(props),
      });
    }

    const ctx = {
      databaseId, props,
      titleProp, platformProp, coverProp,
      authorProp, publisherProp, genreProp,
      keyword1Prop, keyword2Prop, keyword3Prop,
      urlProp, guideProp, descProp,
    };

    // 배치 저장 { items: [...] }
    const items = Array.isArray(body?.items) ? body.items : null;

    if (items && items.length) {
      const results = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const r = await createOne(items[i], ctx);
          results.push({ index: i, ...r });
        } catch (e) {
          results.push({
            index: i,
            ok: false,
            error: e?.message || "Unknown error",
            details: e?.body || null,
          });
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;

      return res.status(200).json({
        ok: failCount === 0,
        mode: "batch",
        total: results.length,
        okCount,
        failCount,
        results,
      });
    }

    // 단일 저장도 지원
    const one = await createOne(body, ctx);
    if (!one.ok) return res.status(400).json(one);

    return res.status(200).json({
      ok: true,
      mode: "single",
      pageId: one.pageId,
      used: {
        platformValue: one.platformValue,
        genreValue: one.genreValue,
        keywordPropUsed: one.keywordPropUsed,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      details: e?.body || null,
    });
  }
};
