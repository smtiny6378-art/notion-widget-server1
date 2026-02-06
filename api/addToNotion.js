// api/addToNotion.js
const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  timeoutMs: Number(process.env.NOTION_TIMEOUT_MS || 120000),
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function withRetry(fn, { tries = 3, baseDelay = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "").toLowerCase();
      const isRetryable =
        msg.includes("timed out") || msg.includes("timeout") ||
        e?.status === 429 || (e?.status >= 500 && e?.status <= 599);
      if (!isRetryable || i === tries - 1) break;
      await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
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

function normName(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[·:：\-–—_]/g, "");
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

function toRichTextParagraphs(value, chunkSize = 2000) {
  const text = normalizeNotionText(value);
  if (!text) return [];
  const hasDouble = text.includes("\n\n");
  const splitRe = hasDouble ? /\n{2,}/g : /\n+/g;

  const paragraphs = text.split(splitRe).map(p => p.trim()).filter(Boolean);
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

function titleFromKakaoUrl(url) {
  try {
    const u = String(url || "").trim();
    const m = u.match(/\/content\/([^/]+)\/(\d+)/);
    if (!m) return "";
    const slug = decodeURIComponent(m[1]);
    return slug.replace(/-/g, " ").trim();
  } catch { return ""; }
}

function inferPlatformFromUrl(url) {
  const u = String(url || "");
  if (u.includes("webtoon.kakao.com")) return "카카오웹툰";
  if (u.includes("page.kakao.com")) return "카카오페이지";
  if (u.includes("ridibooks.com")) return "RIDI";
  return "";
}

function safeJsonBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
  return body || {};
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

// 옵션 자동생성 기본 OFF (타임아웃 방지)
const AUTO_CREATE_OPTIONS = String(process.env.NOTION_AUTO_CREATE_OPTIONS || "").trim().toLowerCase() === "true";

async function ensureSelectOption(databaseId, dbProps, propName, value) {
  if (!AUTO_CREATE_OPTIONS) return { added: [] };
  if (!value) return { added: [] };
  const prop = dbProps[propName];
  if (!prop || prop.type !== "select") return { added: [] };

  const existing = prop.select?.options || [];
  if (existing.some((o) => o.name === value)) return { added: [] };
  const newOptions = [...existing.map((o) => ({ name: o.name })), { name: value }];

  await withRetry(() => notion.databases.update({
    database_id: databaseId,
    properties: { [propName]: { select: { options: newOptions } } },
  }));
  return { added: [value] };
}

async function ensureMultiSelectOptions(databaseId, dbProps, propName, values) {
  if (!AUTO_CREATE_OPTIONS) return { added: [] };
  const arr = normalizeArray(values);
  if (!arr.length) return { added: [] };

  const prop = dbProps[propName];
  if (!prop || prop.type !== "multi_select") return { added: [] };

  const existing = prop.multi_select?.options || [];
  const existingSet = new Set(existing.map((o) => o.name));
  const need = Array.from(new Set(arr)).filter((v) => v && !existingSet.has(v));
  if (!need.length) return { added: [] };

  const newOptions = [...existing.map((o) => ({ name: o.name })), ...need.map((name) => ({ name }))];

  await withRetry(() => notion.databases.update({
    database_id: databaseId,
    properties: { [propName]: { multi_select: { options: newOptions } } },
  }));
  return { added: need };
}

function cleanPublisher(p){
  const s = String(p || "").trim();
  if (!s) return "";
  if (s.includes("AI 매칭")) return "";
  if (s.includes("<")) return "";
  return s;
}

// ✅ 19세 표기 규칙:
// - 접두어로 붙이지 않음
// - 기존 [19세 완전판]이 앞/뒤 어디에 있든 싹 제거한 뒤
// - 성인작이면 "뒤에 1번만" 붙임
function normalize19TagOnce(title, isAdult){
  let t = String(title || "").trim();
  t = t.replace(/\s*\|\s*카카오웹툰\s*$/g, "").trim();

  t = t.replace(/\[19세\s*완전판\]\s*/g, "").trim();     // 앞에 붙은 것 제거
  t = t.replace(/\s*\[19세\s*완전판\]\s*$/g, "").trim(); // 뒤에 붙은 것 제거

  if (isAdult) t = `${t} [19세 완전판]`.trim();
  return t;
}

function cleanGenreArr(arr){
  const bad = new Set(["를", "을", "이", "가", "은", "는", "의", "에", "에서", "와", "과"]);
  return (arr || [])
    .map(x => String(x || "").trim())
    .filter(Boolean)
    .filter(x => !bad.has(x));
}

// ---------------- core ----------------
async function createOne(rawItem, ctx) {
  const {
    databaseId, props, titleProp, platformProp, coverProp,
    authorProp, publisherProp, genreProp, keywordsProp,
    urlProp, guideProp, descProp,
  } = ctx;

  const body = (rawItem && rawItem.data && typeof rawItem.data === "object") ? rawItem.data : rawItem;

  const urlValue = (body?.url ?? body?.link)?.toString?.().trim?.() || "";

  let title = body?.title?.toString?.().trim?.() || "";
  if (!title && urlValue) title = titleFromKakaoUrl(urlValue);
  if (!title) return { ok: false, error: "title is required" };

  const isAdult =
    body?.isAdult === true ||
    body?.adult === true ||
    body?.is19 === true ||
    String(body?.ageLimit || "").includes("19") ||
    String(body?.rating || "").includes("19");

  title = normalize19TagOnce(title, isAdult);

  const coverUrl = body?.coverUrl?.toString?.().trim?.() || "";

  const platformValue =
    (body?.platform?.toString?.().trim?.() || "") ||
    inferPlatformFromUrl(urlValue) ||
    "RIDI";

  const authorName = (body?.authorName ?? body?.author ?? "").toString().trim();

  // ✅ 출판사는 깨끗할 때만 저장
  const publisherName = cleanPublisher(body?.publisherName ?? body?.publisher ?? "");

  const genreArr = cleanGenreArr(normalizeArray(body?.genre));
  const tagsArr = normalizeArray(body?.tags ?? body?.keywords);

  const guideText = normalizeNotionText(body?.guide ?? body?.romanceGuide ?? "");
  const descText = normalizeNotionText(body?.description ?? body?.meta ?? body?.desc ?? "");

  const genreValue = genreArr[0] || "";

  // ✅ 19 관련 태그 제거
  const keywordValues = Array.from(new Set(tagsArr))
    .filter((t) => {
      const s = String(t || "").trim();
      const n = s.replace(/\s+/g, "").toLowerCase();
      if (n === "19" || n === "19세" || n.includes("19세")) return false;
      if (n.includes("미만이용불가") || n.includes("성인") || n.includes("청소년이용불가")) return false;
      return true;
    });

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

  if (genreProp && genreValue) {
    const v = setSelectValue(props, genreProp, genreValue);
    if (v) properties[genreProp] = v;
  }

  if (keywordsProp && keywordValues.length) {
    const v = setMultiSelectValue(props, keywordsProp, keywordValues);
    if (v) properties[keywordsProp] = v;
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
    }),
    { tries: 3, baseDelay: 500 }
  );

  return {
    ok: true,
    pageId: created.id,
    createdOptions,
    usedValues: { platformValue, genreValue, keywordValues },
    title,
    url: urlValue,
  };
}

// ---------------- handler ----------------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const body = safeJsonBody(req);

  try {
    // ✅ 여기서 DB를 "기존에 쓰던 DB"로 고정 (환경변수 무시)
    const databaseId = "2d8229f54c468182b318e9130eaae3e8";

    const db = await withRetry(() => notion.databases.retrieve({ database_id: databaseId }));
    const props = db?.properties || {};

    const titleProp =
      findPropByNameAndType(props, ["제목", "title", "name", "이름"], "title") ||
      firstPropOfType(props, "title");

    const platformProp =
      findPropByNameAndType(props, ["플랫폼", "platform"], "select") || null;

    const coverProp =
      findPropByNameAndType(props, ["표지", "커버", "cover", "이미지"], "files") ||
      firstPropOfType(props, "files");

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

    const ctx = {
      databaseId, props, titleProp, platformProp, coverProp,
      authorProp, publisherProp, genreProp, keywordsProp,
      urlProp, guideProp, descProp,
    };

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
      const okCount = results.filter(r => r.ok).length;
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

    const one = await createOne(body, ctx);
    if (!one.ok) return res.status(400).json(one);

    return res.status(200).json({
      ok: true,
      mode: "single",
      pageId: one.pageId,
      createdOptions: one.createdOptions,
      usedValues: one.usedValues,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      details: e?.body || null,
    });
  }
};
