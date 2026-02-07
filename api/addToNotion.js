// api/addToNotion.js
const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  timeoutMs: Number(process.env.NOTION_TIMEOUT_MS || 120000),
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
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
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,|]/g).map((s) => s.trim()).filter(Boolean);
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
  if (u.includes("webtoon.kakao.com")) return "KAKAO";
  if (u.includes("page.kakao.com")) return "KAKAO";
  if (u.includes("ridibooks.com")) return "RIDI";
  return "";
}

// ✅ 카카오 꼬리표 제거 + 기존 [19세 완전판] 제거(중복 방지)
function stripKakaoSuffixAnd19(title) {
  let t = String(title || "").trim();
  t = t.replace(/\s*\|\s*카카오웹툰\s*$/g, "").trim();
  t = t.replace(/\[19세\s*완전판\]\s*/g, "").trim();
  t = t.replace(/\s*\[19세\s*완전판\]\s*$/g, "").trim();
  return t;
}

// ✅ 플랫폼별 19세 제목 규칙
// - 카카오웹툰/카카오페이지: 성인작이면 뒤에 [19세 완전판] 1회 붙임
// - RIDI: 성인작이어도 절대 붙이지 않음 (항상 순수 제목)
function applyAdultTitleRule(title, isAdult, platformValue) {
  const base = stripKakaoSuffixAnd19(title);
  const isKakao = platformValue === "카카오웹툰" || platformValue === "카카오페이지";
  const isRidi = platformValue === "RIDI";

  if (isKakao && isAdult) return `${base} [19세 완전판]`.trim();
  if (isRidi) return base; // ✅ RIDI는 항상 붙이지 않음
  // 기타 플랫폼은 보수적으로: 안 붙임
  return base;
}

// ✅ 19 관련 키워드 제거 (# 유무 고려)
function cleanKeywords(tagsArr){
  return Array.from(new Set(normalizeArray(tagsArr))).filter((t) => {
    const s = String(t || "").trim();
    const n = s.replace(/\s+/g, "").toLowerCase();
    if (n === "19" || n === "#19" || n === "19세" || n === "#19세" || n.includes("19세")) return false;
    if (n.includes("미만이용불가") || n.includes("성인") || n.includes("청소년이용불가")) return false;
    return true;
  });
}

// ✅ 키워드 비교용 정규화: # 제거 + 공백 제거 + 소문자
function normKeywordForMatch(s) {
  return String(s || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// 옵션 자동생성 (원하면 Vercel env NOTION_AUTO_CREATE_OPTIONS=true)
const AUTO_CREATE_OPTIONS =
  String(process.env.NOTION_AUTO_CREATE_OPTIONS || "").trim().toLowerCase() === "true";

async function ensureSelectOption(databaseId, dbProps, propName, value) {
  if (!AUTO_CREATE_OPTIONS) return { added: [] };
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
  await withRetry(() =>
    notion.databases.update({
      database_id: databaseId,
      properties: { [propName]: { multi_select: { options: newOptions } } },
    })
  );
  return { added: need };
}

function getSelectOptionsSet(dbProps, propName) {
  const prop = dbProps[propName];
  if (!prop || prop.type !== "select") return new Set();
  const opts = prop.select?.options || [];
  return new Set(opts.map((o) => o.name));
}

/**
 * ✅ 키워드 옵션 기반 매칭 (# 유무 정규화 지원)
 * - 저장은 "DB 옵션명 그대로"(# 포함) 저장
 */
function mapKeywordsByExistingOptions(allKeywords, dbProps) {
  const cols = ["Keyword(1)", "Keyword(2)", "Keyword(3)"];

  const colDict = {};
  for (const col of cols) {
    const prop = dbProps[col];
    const opts =
      prop && prop.type === "multi_select" && prop.multi_select?.options
        ? prop.multi_select.options
        : [];
    const dict = new Map();
    for (const o of opts) {
      const actual = o.name;
      const key = normKeywordForMatch(actual);
      if (key) dict.set(key, actual);
    }
    colDict[col] = dict;
  }

  const result = { "Keyword(1)": [], "Keyword(2)": [], "Keyword(3)": [], unknown: [] };

  for (const kw of allKeywords) {
    const nk = normKeywordForMatch(kw);
    if (!nk) continue;

    let placed = false;
    for (const col of cols) {
      const actual = colDict[col].get(nk);
      if (actual) {
        result[col].push(actual);
        placed = true;
        break;
      }
    }
    if (!placed) result.unknown.push(kw);
  }

  for (const col of cols) result[col] = Array.from(new Set(result[col]));
  result.unknown = Array.from(new Set(result.unknown));
  return result;
}

// ---------------- core ----------------
async function createOne(rawItem, ctx) {
  const { databaseId, props, platformOptionsSet, genreOptionsSet } = ctx;

  const body =
    rawItem && rawItem.data && typeof rawItem.data === "object"
      ? rawItem.data
      : rawItem && typeof rawItem === "object"
      ? rawItem
      : {};

  const urlValue = (body?.url ?? body?.link ?? "").toString().trim();

  // title 후보 넓게
  let rawTitle = (body?.title ?? body?.name ?? body?.bookTitle ?? body?.workTitle ?? "").toString().trim();
  if (!rawTitle && urlValue) rawTitle = titleFromKakaoUrl(urlValue);
  if (!rawTitle) return { ok: false, error: "title is required", debugKeys: Object.keys(body || {}) };

  const isAdult =
    body?.isAdult === true ||
    body?.adult === true ||
    body?.is19 === true ||
    String(body?.ageLimit || "").includes("19") ||
    String(body?.rating || "").includes("19");

  const coverUrl = (body?.coverUrl ?? body?.cover ?? "").toString().trim();

  const platformRaw =
    (body?.platform ?? "").toString().trim() || inferPlatformFromUrl(urlValue) || "RIDI";
  let platformValue = platformRaw;

  if (platformValue && !platformOptionsSet.has(platformValue)) {
    if (AUTO_CREATE_OPTIONS) await ensureSelectOption(databaseId, props, "Platform", platformValue);
    else platformValue = "";
  }

  // ✅ 플랫폼이 확정된 뒤에 19세 제목 규칙 적용
  const title = applyAdultTitleRule(rawTitle, isAdult, platformRaw);

  const authorName = (body?.authorName ?? body?.author ?? "").toString().trim();
  const publisherName = (body?.publisherName ?? body?.publisher ?? "").toString().trim();

  const genreCandidates = normalizeArray(body?.genre);
  let genreValue = "";
  for (const g of genreCandidates) {
    const s = String(g || "").trim();
    if (s && genreOptionsSet.has(s)) { genreValue = s; break; }
  }
  if (!genreValue && genreCandidates.length) {
    const first = String(genreCandidates[0] || "").trim();
    if (first && AUTO_CREATE_OPTIONS) {
      await ensureSelectOption(databaseId, props, "Genre", first);
      genreValue = first;
    }
  }

  const inputKeywords = cleanKeywords([
    ...normalizeArray(body?.tags ?? body?.keywords),
    ...normalizeArray(body?.keyword1),
    ...normalizeArray(body?.keyword2),
    ...normalizeArray(body?.keyword3),
  ]);

  const guideText = normalizeNotionText(body?.guide ?? body?.romanceGuide ?? "");
  const descText = normalizeNotionText(body?.description ?? body?.meta ?? body?.desc ?? body?.summary ?? "");

  const mapped = mapKeywordsByExistingOptions(inputKeywords, props);
  const kw1 = mapped["Keyword(1)"];
  const kw2 = mapped["Keyword(2)"];
  const kw3 = mapped["Keyword(3)"];
  const unknownKeywords = mapped.unknown;

  if (AUTO_CREATE_OPTIONS) {
    await ensureMultiSelectOptions(databaseId, props, "Keyword(1)", kw1);
    await ensureMultiSelectOptions(databaseId, props, "Keyword(2)", kw2);
    await ensureMultiSelectOptions(databaseId, props, "Keyword(3)", kw3);
  }

  const properties = {
    "Title": { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },

    ...(platformValue ? { "Platform": { select: { name: platformValue } } } : {}),
    ...(urlValue ? { "URL": { url: urlValue } } : {}),
    ...(authorName ? { "Author": { rich_text: [{ type: "text", text: { content: authorName } }] } } : {}),
    ...(publisherName ? { "Publisher": { rich_text: [{ type: "text", text: { content: publisherName } }] } } : {}),
    ...(genreValue ? { "Genre": { select: { name: genreValue } } } : {}),

    ...(guideText ? { "가이드": { rich_text: [{ type: "text", text: { content: guideText } }] } } : {}),
    ...(descText ? { "작품 소개": { rich_text: [{ type: "text", text: { content: descText } }] } } : {}),
  };

  if (coverUrl) {
    properties["Cover"] = {
      files: [{ type: "external", name: "cover", external: { url: coverUrl } }],
    };
  }

  if (kw1.length) properties["Keyword(1)"] = { multi_select: kw1.map((name) => ({ name })) };
  if (kw2.length) properties["Keyword(2)"] = { multi_select: kw2.map((name) => ({ name })) };
  if (kw3.length) properties["Keyword(3)"] = { multi_select: kw3.map((name) => ({ name })) };

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
    usedValues: {
      title,
      platformRaw,
      genreSaved: genreValue || "",
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
    const databaseId = "2d8229f54c468182b318e9130eaae3e8";

    const db = await withRetry(() => notion.databases.retrieve({ database_id: databaseId }));
    const props = db?.properties || {};

    const platformOptionsSet = getSelectOptionsSet(props, "Platform");
    const genreOptionsSet = getSelectOptionsSet(props, "Genre");

    const ctx = { databaseId, props, platformOptionsSet, genreOptionsSet };

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
            details: e?.body ? JSON.stringify(e.body) : null,
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

    const one = await createOne(body, ctx);
    if (!one.ok) return res.status(400).json(one);

    return res.status(200).json({
      ok: true,
      mode: "single",
      pageId: one.pageId,
      usedValues: one.usedValues,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      notionStatus: e?.status || null,
      notionCode: e?.code || null,
      details: e?.body ? JSON.stringify(e.body) : null,
    });
  }
};

} catch (e) {
  console.error("❌ addToNotion fatal:", e);
  return res.status(500).json({
    ok: false,
    error: e?.message || "Unknown error",
    status: e?.status || null,
    code: e?.code || null,
    body: e?.body || null,
    stack: e?.stack || null,
  });
}
