// api/addToNotion.js
const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  timeoutMs: Number(process.env.NOTION_TIMEOUT_MS || 120000),
});

// ------------------ utils ------------------
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function withRetry(fn, { tries = 3, baseDelay = 400 } = {}) {
  let lastErr;
  for (let i=0;i<tries;i++){
    try { return await fn(); }
    catch(e){
      lastErr = e;
      const msg = String(e?.message||"").toLowerCase();
      const retryable =
        msg.includes("timed out") || msg.includes("timeout") ||
        e?.status === 429 || (e?.status>=500 && e?.status<=599);
      if (!retryable || i===tries-1) break;
      await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function safeJsonBody(req){
  let body = req.body;
  if (typeof body === "string"){ try{ body = JSON.parse(body); }catch{} }
  return body || {};
}

function normalizeArray(v){
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map(s=>s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,|]/g).map(s=>s.trim()).filter(Boolean);
  return [];
}

function normalizeNotionText(v){
  if (v == null) return "";
  return String(v).replace(/\r\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

function toRichTextParagraphs(value, chunkSize=2000){
  const text = normalizeNotionText(value);
  if (!text) return [];
  const splitRe = text.includes("\n\n") ? /\n{2,}/g : /\n+/g;
  const paragraphs = text.split(splitRe).map(p=>p.trim()).filter(Boolean);

  const out = [];
  for (let i=0;i<paragraphs.length;i++){
    const p = i<paragraphs.length-1 ? paragraphs[i]+"\n\n" : paragraphs[i];
    for (let j=0;j<p.length;j+=chunkSize){
      const chunk = p.slice(j, j+chunkSize);
      if (chunk) out.push({ type:"text", text:{ content: chunk } });
      if (out.length>=100) break;
    }
    if (out.length>=100) break;
  }
  return out.slice(0,100);
}

function normName(s){
  return String(s||"").trim().toLowerCase().replace(/\s+/g,"").replace(/[·:：\-–—_]/g,"");
}
function firstPropOfType(props, type){
  return Object.keys(props).find(k=>props[k]?.type===type) || null;
}
function findPropByNameAndType(props, names, types){
  const nameSet = new Set(names.map(normName));
  const typeSet = new Set(Array.isArray(types)?types:[types]);
  for (const key of Object.keys(props)){
    const p = props[key];
    if (!p || !typeSet.has(p.type)) continue;
    if (nameSet.has(normName(key))) return key;
  }
  return null;
}
function setSelectValue(props, propName, value){
  const p = props[propName];
  if (!p || p.type!=="select" || !value) return null;
  return { select: { name: value } };
}
function setMultiSelectValue(props, propName, values){
  const p = props[propName];
  if (!p || p.type!=="multi_select") return null;
  const arr = Array.from(new Set(normalizeArray(values)));
  if (!arr.length) return null;
  return { multi_select: arr.map(name=>({ name })) };
}

// ------------------ business rules ------------------
function inferSource(url){
  const u = String(url||"");
  if (u.includes("ridibooks.com")) return "RIDI";
  if (u.includes("webtoon.kakao.com")) return "KAKAO_WEBTOON";
  if (u.includes("page.kakao.com")) return "KAKAO_PAGE";
  return "";
}
function toNotionPlatform(url, explicit){
  const e = String(explicit||"").toUpperCase();
  if (e==="RIDI") return "RIDI";
  if (e==="KAKAO") return "KAKAO";
  const s = inferSource(url);
  if (s==="RIDI") return "RIDI";
  if (s==="KAKAO_WEBTOON" || s==="KAKAO_PAGE") return "KAKAO";
  return "RIDI";
}
function stripHash(s){
  return String(s||"").trim().replace(/^#+\s*/g,"").trim();
}
function isAdult(body){
  if (body?.isAdult===true) return true;
  if (body?.adult===true) return true;
  if (body?.is19===true) return true;
  if (String(body?.ageLimit||"").includes("19")) return true;
  if (String(body?.rating||"").includes("19")) return true;
  return false;
}
function normalize19SuffixForKakaoWebtoonOnly(title, adult, url){
  const src = inferSource(url);
  let t = String(title||"").replace(/\s*\|\s*카카오웹툰\s*$/g,"").trim();
  t = t.replace(/\[19세\s*완전판\]\s*/g,"").trim();
  if (src==="KAKAO_WEBTOON" && adult) t = `${t} [19세 완전판]`;
  return t;
}
const ALLOWED_GENRES = ["로맨스","로맨스판타지","BL","판타지"];
function mapGenre(raw){
  const arr = normalizeArray(raw).map(x=>x.replace(/\s+/g,""));
  const hay = arr.join(" ").toLowerCase();
  if (hay.includes("bl")) return "BL";
  if (hay.includes("로맨스판타지") || hay.includes("로판")) return "로맨스판타지";
  if (hay.includes("판타지")) return "판타지";
  return "로맨스";
}
function normalizeKeywords(values){
  return Array.from(new Set(normalizeArray(values)))
    .map(stripHash)
    .filter(Boolean)
    .filter(v=>{
      const n = v.replace(/\s+/g,"").toLowerCase();
      if (!n) return false;
      if (n==="19" || n==="19세" || n.includes("19세")) return false;
      if (n.includes("성인") || n.includes("청소년이용불가") || n.includes("미만이용불가")) return false;
      return true;
    });
}
function pickKeywordProp(genre, k1, k2, k3){
  if (genre==="BL") return k2 || k1 || k3 || null;
  if (genre==="판타지") return k3 || k1 || k2 || null;
  // 로맨스 / 로맨스판타지
  return k1 || k2 || k3 || null;
}

// ------------------ core ------------------
async function createOne(item, ctx){
  const body = (item && item.data && typeof item.data==="object") ? item.data : item;

  const url = (body?.url || body?.link || "").toString().trim();
  let title = (body?.title || "").toString().trim();
  if (!title) return { ok:false, error:"title is required" };

  const adult = isAdult(body);
  title = normalize19SuffixForKakaoWebtoonOnly(title, adult, url);

  const platformValue = toNotionPlatform(url, body?.platform);
  const genreValue = mapGenre(body?.genre);
  const keywords = normalizeKeywords(body?.tags || body?.keywords || []);

  const keywordProp = pickKeywordProp(
    genreValue,
    ctx.keyword1Prop,
    ctx.keyword2Prop,
    ctx.keyword3Prop
  );

  const props = {
    [ctx.titleProp]: { title: [{ type:"text", text:{ content: title.slice(0,2000) } }] },
  };

  if (ctx.platformProp){
    const v = setSelectValue(ctx.dbProps, ctx.platformProp, platformValue);
    if (v) props[ctx.platformProp] = v;
  }
  if (ctx.urlProp && url){
    props[ctx.urlProp] = { url };
  }
  if (ctx.coverProp && body?.coverUrl){
    props[ctx.coverProp] = {
      files: [{ type:"external", name:"cover", external:{ url: body.coverUrl } }]
    };
  }
  if (ctx.authorProp && body?.authorName){
    props[ctx.authorProp] = { rich_text: toRichTextParagraphs(body.authorName) };
  }
  if (ctx.publisherProp && body?.publisherName){
    props[ctx.publisherProp] = { rich_text: toRichTextParagraphs(body.publisherName) };
  }
  if (ctx.genreProp){
    const v = setSelectValue(ctx.dbProps, ctx.genreProp, genreValue);
    if (v) props[ctx.genreProp] = v;
  }
  if (keywordProp && keywords.length){
    const v = setMultiSelectValue(ctx.dbProps, keywordProp, keywords);
    if (v) props[keywordProp] = v;
  }
  if (ctx.guideProp && body?.guide){
    props[ctx.guideProp] = { rich_text: toRichTextParagraphs(body.guide) };
  }
  if (ctx.descProp && body?.description){
    props[ctx.descProp] = { rich_text: toRichTextParagraphs(body.description) };
  }

  const created = await withRetry(() =>
    notion.pages.create({
      parent: { database_id: ctx.databaseId },
      properties: props,
    })
  );

  return { ok:true, pageId: created.id, title };
}

// ------------------ handler ------------------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();
  if (req.method!=="POST") return res.status(405).end();

  try{
    const body = safeJsonBody(req);
    const databaseId = process.env.NOTION_DB_ID;
    if (!databaseId) return res.status(500).json({ ok:false, error:"NOTION_DB_ID is missing" });

    const db = await withRetry(()=> notion.databases.retrieve({ database_id: databaseId }));
    const props = db.properties || {};

    const ctx = {
      databaseId,
      dbProps: props,
      titleProp: findPropByNameAndType(props, ["Title","제목","title"], "title") || firstPropOfType(props,"title"),
      platformProp: findPropByNameAndType(props, ["Platform","플랫폼","platform"], "select"),
      coverProp: findPropByNameAndType(props, ["Cover","표지","커버","cover"], "files") || firstPropOfType(props,"files"),
      authorProp: findPropByNameAndType(props, ["Author","작가명","작가"], "rich_text"),
      publisherProp: findPropByNameAndType(props, ["Publisher","출판사명","출판사"], "rich_text"),
      genreProp: findPropByNameAndType(props, ["Genre","장르"], "select"),
      keyword1Prop: findPropByNameAndType(props, ["Keyword(1)","Keyword1","키워드1"], "multi_select"),
      keyword2Prop: findPropByNameAndType(props, ["Keyword(2)","Keyword2","키워드2"], "multi_select"),
      keyword3Prop: findPropByNameAndType(props, ["Keyword(3)","Keyword3","키워드3"], "multi_select"),
      urlProp: findPropByNameAndType(props, ["URL","url","링크"], "url") || firstPropOfType(props,"url"),
      guideProp: findPropByNameAndType(props, ["가이드","Guide","guide"], "rich_text"),
      descProp: findPropByNameAndType(props, ["작품 소개","Description","소개"], "rich_text"),
    };

    const items = Array.isArray(body?.items) ? body.items : null;

    if (items && items.length){
      const results = [];
      for (let i=0;i<items.length;i++){
        try {
          const r = await createOne(items[i], ctx);
          results.push({ index:i, ...r });
        } catch(e){
          results.push({ index:i, ok:false, error:e?.message || "error" });
        }
      }
      const okCount = results.filter(r=>r.ok).length;
      return res.status(200).json({ ok: okCount===results.length, results, okCount, total: results.length });
    }

    const one = await createOne(body, ctx);
    return res.status(200).json({ ok:true, pageId: one.pageId });

  } catch(e){
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
};
