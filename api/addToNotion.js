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

function safeJsonBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
  return body || {};
}

function normalizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,|]/g).map(s => s.trim()).filter(Boolean);
  return [];
}

function normalizeNotionText(v) {
  if (v == null) return "";
  return String(v).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

// ✅ 19세 표기 규칙 유지
function normalize19TagOnce(title, isAdult){
  let t = String(title || "").trim();
  t = t.replace(/\s*\|\s*카카오웹툰\s*$/g, "").trim();
  t = t.replace(/\[19세\s*완전판\]\s*/g, "").trim();
  t = t.replace(/\s*\[19세\s*완전판\]\s*$/g, "").trim();
  if (isAdult) t = `${t} [19세 완전판]`.trim();
  return t;
}

// ✅ 19 관련 키워드 제거
function cleanKeywords(tagsArr){
  return Array.from(new Set(normalizeArray(tagsArr))).filter((t) => {
    const s = String(t || "").trim();
    const n = s.replace(/\s+/g, "").toLowerCase();
    if (n === "19" || n === "19세" || n.includes("19세")) return false;
    if (n.includes("미만이용불가") || n.includes("성인") || n.includes("청소년이용불가")) return false;
    return true;
  });
}

// 옵션 자동생성 (원하면 Vercel env NOTION_AUTO_CREATE_OPTIONS=true)
const AUTO_CREATE_OPTIONS = String(process.env.NOTION_AUTO_CREATE_OPTIONS || "").trim().toLowerCase() === "true";

async function ensureMultiSelectOptions(databaseId, dbProps, propName, values) {
  if (!AUTO_CREATE_OPTIONS) return { added: [] };
  const arr = normalizeArray(values);
  if (!arr.length) return { added: [] };

  const prop = dbProps[propName];
  if (!prop || prop.type !== "multi_select") return { added: [] };

  const existing = prop.multi_select?.options || [];
  const existingSet = new Set(existing.map(o => o.name));
  const need = Array.from(new Set(arr)).filter(v => v && !existingSet.has(v));
  if (!need.length) return { added: [] };

  const newOptions = [...existing.map(o => ({ name: o.name })), ...need.map(name => ({ name }))];

  await withRetry(() => notion.databases.update({
    database_id: databaseId,
    properties: { [propName]: { multi_select: { options: newOptions } } },
  }));
  return { added: need };
}

async function ensureSelectOption(databaseId, dbProps, propName, value) {
  if (!AUTO_CREATE_OPTIONS) return { added: [] };
  if (!value) return { added: [] };

  const prop = dbProps[propName];
  if (!prop || prop.type !== "select") return { added: [] };

  const existing = prop.select?.options || [];
  if (existing.some(o => o.name === value)) return { added: [] };

  const newOptions = [...existing.map(o => ({ name: o.name })), { name: value }];

  await withRetry(() => notion.databases.update({
    database_id: databaseId,
    properties: { [propName]: { select: { options: newOptions } } },
  }));
  return { added: [value] };
}

/**
 * ✅ 키워드 매핑 핵심:
 * - DB의 Keyword(1/2/3) 옵션 목록을 읽는다
 * - 입력 키워드가 "어느 컬럼 옵션에 존재하는지"로 분류한다
 * - 존재하지 않는 키워드는 기본적으로 버린다 (원하면 AUTO_CREATE_OPTIONS 켜서 생성 가능)
 */
function mapKeywordsByExistingOptions(allKeywords, dbProps) {
  const cols = ["Keyword(1)", "Keyword(2)", "Keyword(3)"];

  const optionSets = {};
  for (const col of cols) {
    const prop = dbProps[col];
    const opts = (prop && prop.type === "multi_select" && prop.multi_select?.options) ? prop.multi_select.options : [];
    optionSets[col] = new Set(opts.map(o => o.name));
  }

  const result = { "Keyword(1)": [], "Keyword(2)": [], "Keyword(3)": [], unknown: [] };

  for (const kw of allKeywords) {
    let placed = false;
    for (const col of cols) {
      if (optionSets[col].has(kw)) {
        result[col].push(kw);
        placed = true;
        break;
      }
    }
    if (!placed) result.unknown.push(kw);
  }

  // 중복 제거
  for (const col of cols) {
    result[col] = Array.from(new Set(result[col]));
  }
  result.unknown = Array.from(new Set(result.unknown));

  return result;
}

// ---------------- core ----------------
async function createOne(rawItem, ctx) {
  const { databaseId, props } = ctx;

  // ✅ {data:{...}} 또는 그냥 {...}
  const body =
    (rawItem && rawItem.data && typeof rawItem.data === "object") ? rawItem.data :
    (rawItem && typeof rawItem === "object") ? rawItem :
    {};

  const urlValue = (body?.url ?? body?.link ?? "").toString().trim();

  // ✅ title 후보를 넓게
  let title =
    (body?.title ?? body?.name ?? body?.bookTitle ?? body?.workTitle ?? "").toString().trim();
  if (!title && urlValue) title = titleFromKakaoUrl(urlValue);
  if (!title) return { ok: false, error: "title is required", debugKeys: Object.keys(body || {}) };

  const isAdult =
    body?.isAdult === true ||
    body?.adult === true ||
    body?.is19 === true ||
    String(body?.ageLimit || "").includes("19") ||
    String(body?.rating || "").includes("19");

  title = normalize19TagOnce(title, isAdult);

  const coverUrl = (body?.coverUrl ?? body?.cover ?? "").toString().trim();

  const platformValue =
    (body?.platform ?? "").toString().trim() ||
    inferPlatformFromUrl(urlValue) ||
    "RIDI";

  const authorName = (body?.authorName ?? body?.author ?? "").toString().trim();
  const publisherName = (body?.publisherName ?? body?.publisher ?? "").toString().trim();
  const genreValue = normalizeArray(body?.genre)[0] || "";

  // ✅ 입력 키워드(평평한 배열) + 혹시 키워드가 분리되어 들어올 경우도 지원
  // - body.keyword1 / keyword2 / keyword3 같은 형태가 오면 거기도 합쳐줌 (있으면)
  const flatKeywords = cleanKeywords([
    ...normalizeArray(body?.tags ?? body?.keywords),
    ...normalizeArray(body?.keyword1),
    ...normalizeArray(body?.keyword2),
    ...normalizeArray(body?.keyword3),
  ]);

  const guideText = normalizeNotionText(body?.guide ?? body?.romanceGuide ?? "");
  const descText = normalizeNotionText(body?.description ?? body?.meta ?? body?.desc ?? body?.summary ?? "");

  // ✅ DB 옵션 기반으로 Keyword(1/2/3) 분류
  const mapped = mapKeywordsByExistingOptions(flatKeywords, props);
  const kw1 = mapped["Keyword(1)"];
  const kw2 = mapped["Keyword(2)"];
  const kw3 = mapped["Keyword(3)"];
  const unknownKeywords = mapped.unknown;

  // ✅ 옵션 자동 생성이 켜져 있으면, unknown을 “어디에도 없으니” 생성할지 결정해야 하는데
  // 여기서는 안전하게: unknown은 생성/저장하지 않음 (원하면 아래 주석 해제해서 Keyword(1)에 넣도록 변경 가능)
  if (AUTO_CREATE_OPTIONS) {
    await ensureSelectOption(databaseId, props, "Platform", platformValue);
    if (genreValue) await ensureSelectOption(databaseId, props, "Genre", genreValue);

    // existing 옵션에 있는 키워드만 넣는 정책이라, 옵션 생성은 굳이 안 함.
    // 원하면 unknown을 특정 컬럼에 생성하도록 바꿀 수 있음.
    await ensureMultiSelectOptions(databaseId, props, "Keyword(1)", kw1);
    await ensureMultiSelectOptions(databaseId, props, "Keyword(2)", kw2);
    await ensureMultiSelectOptions(databaseId, props, "Keyword(3)", kw3);
  }

  const properties = {
    "제목": { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
    "Platform": platformValue ? { select: { name: platformValue } } : undefined,
    "URL": urlValue ? { url: urlValue } : undefined,
    "Author": authorName ? { rich_text: [{ type: "text", text: { content: authorName } }] } : undefined,
    "Publisher": publisherName ? { rich_text: [{ type: "text", text: { content: publisherName } }] } : undefined,
    "Genre": genreValue ? { select: { name: genreValue } } : undefined,
    "가이드": guideText ? { rich_text: [{ type: "text", text: { content: guideText } }] } : undefined,
    "작품 소개": descText ? { rich_text: [{ type: "text", text: { content: descText } }] } : undefined,
  };

  if (coverUrl) {
    properties["Cover"] = {
      files: [{ type: "external", name: "cover", external: { url: coverUrl } }],
    };
  }

  if (kw1.length) properties["Keyword(1)"] = { multi_select: kw1.map(name => ({ name })) };
  if (kw2.length) properties["Keyword(2)"] = { multi_select: kw2.map(name => ({ name })) };
  if (kw3.length) properties["Keyword(3)"] = { multi_select: kw3.map(name => ({ name })) };

  for (const k of Object.keys(properties)) {
    if (properties[k] === undefined) delete properties[k];
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
    usedValues: {
      title,
      platformValue,
      genreValue,
      keywordMatched: kw1.length + kw2.length + kw3.length,
      keywordUnknown: unknownKeywords,
    },
  };
}

// ---------------- handler ----------------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    // ✅ DB 고정
    const databaseId = "2d8229f54c468182b318e9130eaae3e8";

    // DB 스키마(옵션 포함) 읽기
    const db = await withRetry(() => notion.databases.retrieve({ database_id: databaseId }));
    const props = db?.properties || {};

    const ctx = { databaseId, props };

    const body = safeJsonBody(req);
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

    return res.status(200).json({ ok: true, mode: "single", pageId: one.pageId, usedValues: one.usedValues });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      details: e?.body || null,
    });
  }
};
