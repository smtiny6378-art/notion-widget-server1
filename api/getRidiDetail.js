// api/getRidiDetail.js
const cheerio = require("cheerio");

const VERSION = "getRidiDetail-2026-02-08-v2-no-rating-fixed-author";

function absolutizeUrl(u) {
  if (!u) return "";
  const url = String(u).trim();
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return "https://ridibooks.com" + url;
  return url;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

module.exports = async function getRidiDetail(html) {
  const $ = cheerio.load(html);

  // 제목
  let title = cleanText($("h1").first().text());

  // 19세 표시
  const isAdult = $("span.badge-adult, span.badge-19").length > 0;
  if (isAdult && !title.includes("[19세 완전판]")) {
    title = `[19세 완전판] ${title}`;
  }

  // 작가명 (관련 작품 목록 영역 제외)
  const authorName = cleanText(
    $(".author_info .author_name").first().text()
  );

  // 출판사
  const publisher = cleanText(
    $(".publisher_info .publisher_name").first().text()
  );

  // 장르
  const genre = [];
  $(".genre_list a").each((_, el) => {
    const g = cleanText($(el).text());
    if (g) genre.push(g);
  });

  // 키워드 (19 관련 제거)
  const keywords = [];
  $(".keyword_list a").each((_, el) => {
    const k = cleanText($(el).text());
    if (k && !k.includes("19")) keywords.push(k);
  });

  // 작품 소개
  const desc = cleanText(
    $(".book_introduce, .detail_introduce").first().text()
  );

  // 로맨스 가이드
  const romanceGuide = cleanText(
    $(".romance_guide, .guide_romance").first().text()
  );

  // 표지
  const coverUrl = absolutizeUrl(
    $("meta[property='og:image']").attr("content")
  );

  return {
    ok: true,
    platform: "RIDI",
    title,
    authorName,
    publisher,
    genre,
    keywords,
    desc,
    romanceGuide,
    coverUrl,
    isAdult,
    _version: VERSION,
  };
};
