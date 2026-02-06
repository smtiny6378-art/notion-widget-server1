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

// 19 태그 정규화 (이미 적용 중이던 규칙 유지)
function normalize19TagOnce(title, isAdult){
  let t = String(title || "").trim();
  t = t.replace(/\s*\|\s*카카오웹툰\s*$/g, "").trim();
  t = t.replace(/\[19세\s*완전판\]\s*/g, "").trim();
  t = t.replace(/\s*\[19세\s*완전판\]\s*$/g, "").trim();
  if (isAdult) t = `${t} [19세 완전판]`.trim();
  return t;
}

// 19 관련 키워드 제거
function cleanKeywords(tagsArr){
  return Array.from(new Set(normalizeArray(tagsArr))).filter((t) => {
    const s = String(t || "").trim();
    const n = s.replace(/\s+/g, "").toLowerCase();
    if (n === "19" || n === "19세" || n.includes("19세")) return false;
    if (n.includes("미만이용불가") || n.includes("성인") || n.includes("청소년이용불가")) return false;
    return true;
  });
}

// 키워드를 3칸으로 분배 (각각 multi-select)
function splitKeywordsTo3Cols(arr){
  const a = arr.slice(0, 3);
  const b = arr.slice(3, 6);
  const c = arr.slice(6, 9);
  return [a, b, c];
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    // ✅ DB 고정
    const databaseId = "2d8229f54c468182b318e9130eaae3e8";

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const urlValue = (body?.url ?? body?.link ?? "").toString().trim();

    let title = body?.title?.toString?.().trim?.() || "";
    if (!title && urlValue) title = titleFromKakaoUrl(urlValue);
    if (!title) return res.status(400).json({ ok: false, error: "title is required" });

    const isAdult =
      body?.isAdult === true ||
      body?.adult === true ||
      body?.is19 === true ||
      String(body?.ageLimit || "").includes("19") ||
      String(body?.rating || "").includes("19");

    title = normalize19TagOnce(title, isAdult);

    const coverUrl = body?.coverUrl?.toString?.().trim?.() || "";
    const platformValue = body?.platform || inferPlatformFromUrl(urlValue) || "RIDI";
    const authorName = (body?.authorName ?? body?.author ?? "").toString().trim();
    const publisherName = (body?.publisherName ?? body?.publisher ?? "").toString().trim();
    const genreValue = normalizeArray(body?.genre)[0] || "";

    const keywordsClean = cleanKeywords(body?.tags ?? body?.keywords);
    const [kw1, kw2, kw3] = splitKeywordsTo3Cols(keywordsClean);

    const guideText = normalizeNotionText(body?.guide ?? body?.romanceGuide ?? "");
    const descText = normalizeNotionText(body?.description ?? body?.meta ?? body?.desc ?? "");

    const properties = {
      "제목": { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
      "Platform": { select: { name: platformValue } },
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

    const created = await withRetry(() =>
      notion.pages.create({
        parent: { database_id: databaseId },
        cover: coverUrl ? { type: "external", external: { url: coverUrl } } : undefined,
        properties,
      }),
      { tries: 3, baseDelay: 500 }
    );

    return res.status(200).json({ ok: true, pageId: created.id });
  } catch (e) {
    console.error("❌ addToNotion error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error", details: e?.body || null });
  }
};
