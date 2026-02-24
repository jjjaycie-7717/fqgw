const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsNative = require("node:fs");
const { randomUUID } = require("node:crypto");
const zlib = require("node:zlib");

const ENV_FILE = path.join(__dirname, ".env");
loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT || 3000);
const WEB_ROOT = path.join(__dirname, "..");
const MAX_BODY_SIZE = 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN || "";
const FEISHU_CONSULTATION_TABLE_ID =
  process.env.FEISHU_CONSULTATION_TABLE_ID || process.env.FEISHU_TABLE_ID || "";
const FEISHU_PHONE_TABLE_ID =
  process.env.FEISHU_PHONE_TABLE_ID || process.env.FEISHU_TABLE_ID || "";
const DEFAULT_CONSULTATION_ARTICLE_LINKS = [
  "https://mp.weixin.qq.com/s/JkexptZT9xz_NKpfCdK7zQ",
  "https://mp.weixin.qq.com/s/JD3u4eH_4gfxdQmXcnr-0Q",
  "https://mp.weixin.qq.com/s/TEijsoqX8L_ZHeuvseuZNg",
  "https://mp.weixin.qq.com/s/rTbXU9BY1U80QUjeNQSm_w",
  "https://mp.weixin.qq.com/s/RPgtbwheTyZROZk59Reu9w",
  "https://mp.weixin.qq.com/s/KLOQtCDaWG38aJvu6oQqkg",
  "https://mp.weixin.qq.com/s/7zmVRhbD-hZmdNFjVk64Ew",
];
const CONSULTATION_ARTICLE_TITLE_OVERRIDES = {
  "https://mp.weixin.qq.com/s/JkexptZT9xz_NKpfCdK7zQ":
    "CreBee V1.4.0 上线｜发布记录模块升级，新增公众号文章发布与微博平台数据查看功能",
  "https://mp.weixin.qq.com/s/JD3u4eH_4gfxdQmXcnr-0Q":
    "CreBee V1.2.4 全新官网上线，平台话题自动适配，高效分发新体验！",
  "https://mp.weixin.qq.com/s/TEijsoqX8L_ZHeuvseuZNg":
    "CreBee V1.2.2 全网首家支持抖音文章发布，新增网易号，发布稳定性全面优化！",
  "https://mp.weixin.qq.com/s/rTbXU9BY1U80QUjeNQSm_w":
    "行业矩阵运营・服饰篇：多品牌协同破局！百丽增长 56%、海澜营收 155 亿的矩阵方法论",
  "https://mp.weixin.qq.com/s/RPgtbwheTyZROZk59Reu9w":
    "为什么有的保洁公司靠短视频月增30%客户？他们拍对了故事",
  "https://mp.weixin.qq.com/s/KLOQtCDaWG38aJvu6oQqkg":
    "剪辑总卡壳？蜂桥创作发布：不会剪辑，也能做出专业短视频",
  "https://mp.weixin.qq.com/s/7zmVRhbD-hZmdNFjVk64Ew":
    "视频大脑V2.0重磅发布！构建电商爆款视频全链路生产体系，助力企业降本增效",
};
const CONSULTATION_ARTICLE_LINKS = (() => {
  const envLinks = parseEnvList(process.env.CONSULTATION_ARTICLE_LINKS || "");
  return envLinks.length > 0 ? envLinks : DEFAULT_CONSULTATION_ARTICLE_LINKS;
})();
const CONSULTATION_MAX_ITEMS = clampNumber(process.env.CONSULTATION_MAX_ITEMS, 1, 30, 9);
const CONSULTATION_CACHE_FILE = path.join(__dirname, "data", "consultation_articles.json");
const DEFAULT_CONSULTATION_ARTICLES = [
  {
    title: "产品动态（产品公众号文章）",
    summary: "内容包括产品动态（产品公众号文章）、产品使用技巧、行业洞察",
    link: "https://mp.weixin.qq.com/s/KLOQtCDaWG38aJvu6oQqkg",
    image: "",
    category: "产品动态",
    sourceName: "产品公众号文章",
    publishedAt: "",
  },
];

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const COMPRESSIBLE_EXTS = new Set([".html", ".css", ".js", ".json", ".svg"]);
const LONG_CACHE_EXTS = new Set([".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

const rateLimitStore = new Map();
const duplicateStore = new Map();
const feishuTokenCache = {
  token: "",
  expiresAtMs: 0,
};
const consultationArticlesCache = {
  items: [...DEFAULT_CONSULTATION_ARTICLES],
  updatedAt: "",
  lastSuccessAt: "",
  error: "",
};

function loadEnvFile(filePath) {
  if (!fsNative.existsSync(filePath)) return;
  const content = fsNative.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(message);
}

function normalizeText(value, maxLength = 100) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeProductList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((item) => normalizeText(item, 30)).filter(Boolean))];
}

function isValidPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  const raw = req.socket?.remoteAddress || "unknown";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

function cleanupRateLimitStore(now) {
  for (const [key, value] of rateLimitStore.entries()) {
    if (now - value.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(key);
    }
  }
}

function isRateLimited(key, now = Date.now()) {
  cleanupRateLimitStore(now);
  const current = rateLimitStore.get(key);
  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(key, { windowStart: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT_MAX_REQUESTS;
}

function cleanupDuplicateStore(now) {
  for (const [key, submittedAt] of duplicateStore.entries()) {
    if (now - submittedAt > DUPLICATE_WINDOW_MS) {
      duplicateStore.delete(key);
    }
  }
}

function hasDuplicateSubmission(key, now = Date.now()) {
  cleanupDuplicateStore(now);
  const prev = duplicateStore.get(key);
  return Boolean(prev && now - prev <= DUPLICATE_WINDOW_MS);
}

function markDuplicateSubmission(key, now = Date.now()) {
  duplicateStore.set(key, now);
}

function hasFeishuConfig() {
  return Boolean(
    FEISHU_APP_ID &&
      FEISHU_APP_SECRET &&
      FEISHU_APP_TOKEN &&
      FEISHU_CONSULTATION_TABLE_ID &&
      FEISHU_PHONE_TABLE_ID,
  );
}

function mapFeishuErrorMessage(error) {
  const raw = String(error?.message || "");
  if (raw.startsWith("feishu_auth_failed:")) {
    return `飞书鉴权失败：${raw.slice("feishu_auth_failed:".length) || "unknown"}`;
  }
  if (raw.startsWith("feishu_record_failed:")) {
    return `飞书写入失败：${raw.slice("feishu_record_failed:".length) || "unknown"}`;
  }
  return "飞书写入失败，请稍后重试";
}

function parseEnvList(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDate(value) {
  const raw = normalizeText(String(value || ""), 80);
  if (!raw) return "";
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toISOString();
}

function sourceNameFromUrl(sourceUrl) {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./i, "");
    if (host.includes("mp.weixin.qq.com")) return "微信公众号";
    return normalizeText(host, 60) || "公众号文章";
  } catch {
    return "公众号文章";
  }
}

function normalizeArticle(raw, fallbackSourceName = "公众号文章") {
  if (!raw || typeof raw !== "object") return null;
  const title = normalizeText(stripHtml(decodeXmlEntities(raw.title || "")), 140);
  const summary = normalizeText(
    stripHtml(decodeXmlEntities(raw.summary || raw.description || raw.content || "")),
    220,
  );
  const link = normalizeText(String(raw.link || raw.url || ""), 600);
  const image = normalizeText(String(raw.image || raw.cover || raw.thumbnail || ""), 600);
  const category = normalizeText(stripHtml(decodeXmlEntities(raw.category || "公众号更新")), 32) || "公众号更新";
  const sourceName =
    normalizeText(stripHtml(decodeXmlEntities(raw.sourceName || fallbackSourceName)), 60) ||
    "公众号文章";
  const publishedAt = normalizeDate(raw.publishedAt || raw.pubDate || raw.updated || "");
  if (!title) return null;
  if (!/^https?:\/\//i.test(link)) return null;
  const normalizedImage = /^https?:\/\//i.test(image) ? image : "";
  return {
    title,
    summary,
    link,
    image: normalizedImage,
    category,
    sourceName,
    publishedAt,
  };
}

function parseXmlTag(block, tagName) {
  const cdataReg = new RegExp(
    `<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tagName}>`,
    "i",
  );
  const cdataMatch = block.match(cdataReg);
  if (cdataMatch) return cdataMatch[1].trim();
  const reg = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(reg);
  return match ? match[1].trim() : "";
}

function parseXmlLink(block) {
  const attrMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (attrMatch) return attrMatch[1].trim();
  return parseXmlTag(block, "link");
}

function parseXmlFeed(rawText, sourceUrl) {
  const sourceName = sourceNameFromUrl(sourceUrl);
  const nodes = [
    ...(rawText.match(/<item\b[\s\S]*?<\/item>/gi) || []),
    ...(rawText.match(/<entry\b[\s\S]*?<\/entry>/gi) || []),
  ];
  return nodes
    .map((node) =>
      normalizeArticle(
        {
          title: parseXmlTag(node, "title"),
          summary:
            parseXmlTag(node, "description") ||
            parseXmlTag(node, "summary") ||
            parseXmlTag(node, "content"),
          link: parseXmlLink(node),
          category: parseXmlTag(node, "category"),
          publishedAt:
            parseXmlTag(node, "pubDate") ||
            parseXmlTag(node, "published") ||
            parseXmlTag(node, "updated"),
          sourceName,
        },
        sourceName,
      ),
    )
    .filter(Boolean);
}

function parseJsonFeed(payload, sourceUrl) {
  const sourceName = sourceNameFromUrl(sourceUrl);
  let rows = [];
  if (Array.isArray(payload)) rows = payload;
  else if (payload && typeof payload === "object") {
    if (Array.isArray(payload.items)) rows = payload.items;
    else if (Array.isArray(payload.data)) rows = payload.data;
    else if (Array.isArray(payload.articles)) rows = payload.articles;
  }
  return rows
    .map((row) =>
      normalizeArticle(
        {
          title: row?.title || row?.name || row?.headline,
          summary:
            row?.summary || row?.description || row?.contentSnippet || row?.content_text || row?.excerpt,
          link: row?.link || row?.url || row?.guid,
          category: row?.category || row?.tag || row?.topic,
          publishedAt:
            row?.publishedAt || row?.pubDate || row?.published || row?.date || row?.updated || row?.isoDate,
          sourceName: row?.sourceName || row?.source || sourceName,
        },
        sourceName,
      ),
    )
    .filter(Boolean);
}

function parseHtmlAttributes(tagText) {
  const attrs = {};
  const reg = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match = reg.exec(tagText);
  while (match) {
    const key = String(match[1] || "").toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    attrs[key] = decodeXmlEntities(value.trim());
    match = reg.exec(tagText);
  }
  return attrs;
}

function extractMetaContent(html, targetKeys) {
  const keySet = new Set(targetKeys.map((item) => String(item).toLowerCase()));
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = parseHtmlAttributes(tag);
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    if (!keySet.has(key)) continue;
    if (attrs.content) return attrs.content;
  }
  return "";
}

function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeXmlEntities(stripHtml(match[1] || ""));
}

function decodeJsEscapedString(value) {
  return String(value || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractWxScriptValue(html, key) {
  const patterns = [
    new RegExp(`var\\s+${key}\\s*=\\s*"((?:\\\\.|[^"])*)";`, "i"),
    new RegExp(`var\\s+${key}\\s*=\\s*'((?:\\\\.|[^'])*)';`, "i"),
    new RegExp(`${key}\\s*:\\s*"((?:\\\\.|[^"])*)"`, "i"),
    new RegExp(`${key}\\s*:\\s*'((?:\\\\.|[^'])*)'`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match || !match[1]) continue;
    return decodeXmlEntities(decodeJsEscapedString(match[1])).trim();
  }
  return "";
}

function toAbsoluteUrl(baseUrl, maybeUrl) {
  const raw = normalizeText(String(maybeUrl || ""), 600);
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return "";
  }
}

function extractWxImageFromScript(html) {
  const msgImage = extractWxScriptValue(html, "msg_cdn_url");
  const headImage = extractWxScriptValue(html, "ori_head_img_url");
  return normalizeText(msgImage || headImage, 600);
}

async function fetchArticleFromLink(link) {
  const fallbackSourceName = sourceNameFromUrl(link);
  const response = await fetch(link, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "FQGW1-ConsultationCard/1.0",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }
  const html = await response.text();
  const finalUrl = response.url || link;
  const wxTitle = extractWxScriptValue(html, "msg_title");
  const wxDesc = extractWxScriptValue(html, "msg_desc");
  const wxNickname = extractWxScriptValue(html, "nickname");
  const siteName = normalizeText(
    extractMetaContent(html, ["og:site_name", "twitter:site"]),
    60,
  );
  const sourceName = wxNickname || siteName || fallbackSourceName;
  const title =
    wxTitle ||
    extractMetaContent(html, ["og:title", "twitter:title"]) ||
    extractTitleTag(html) ||
    "公众号文章";
  const summary =
    extractMetaContent(html, ["og:description", "description", "twitter:description"]) ||
    wxDesc;
  const metaImage = extractMetaContent(html, ["og:image", "twitter:image", "twitter:image:src"]);
  const imageUrl = toAbsoluteUrl(
    finalUrl,
    metaImage || extractWxImageFromScript(html),
  );
  const publishedAt =
    normalizeDate(extractMetaContent(html, ["article:published_time", "og:published_time"])) ||
    "";
  return normalizeArticle(
    {
      title,
      summary,
      link: finalUrl,
      image: imageUrl,
      category: "公众号文章",
      sourceName,
      publishedAt,
    },
    sourceName,
  );
}

function articleTimestamp(item) {
  const timestamp = Date.parse(item?.publishedAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function dedupeAndSortArticles(items) {
  const seenLinks = new Set();
  const result = [];
  for (const item of items) {
    if (seenLinks.has(item.link)) continue;
    seenLinks.add(item.link);
    result.push(item);
    if (result.length >= CONSULTATION_MAX_ITEMS) break;
  }
  return result;
}

function isLikelyUrl(value) {
  return /^https?:\/\//i.test(normalizeText(String(value || ""), 600));
}

function buildFallbackArticle(link, previousItem) {
  const mappedTitle = normalizeText(CONSULTATION_ARTICLE_TITLE_OVERRIDES[link], 140);
  if (previousItem && previousItem.link === link) {
    const safeTitle = normalizeText(previousItem.title, 140);
    const previousSummary = normalizeText(previousItem.summary, 220);
    const safeSummary = previousSummary === "点击查看公众号原文" ? "" : previousSummary;
    return {
      ...previousItem,
      title: mappedTitle || (safeTitle && !isLikelyUrl(safeTitle) ? safeTitle : "公众号原文标题"),
      summary: safeSummary,
      category: normalizeText(previousItem.category, 32) || "公众号文章",
      sourceName: normalizeText(previousItem.sourceName, 60) || sourceNameFromUrl(link),
      image: normalizeText(previousItem.image, 600),
    };
  }
  const sourceName = sourceNameFromUrl(link);
  return {
    title: mappedTitle || "公众号原文标题",
    summary: "",
    link,
    image: "",
    category: "公众号文章",
    sourceName,
    publishedAt: "",
  };
}

async function loadConsultationArticleCache() {
  try {
    const raw = await fs.readFile(CONSULTATION_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items)
      ? dedupeAndSortArticles(parsed.items.map((item) => normalizeArticle(item)).filter(Boolean))
      : [];
    if (items.length > 0) {
      consultationArticlesCache.items = items;
    }
    consultationArticlesCache.updatedAt = normalizeText(String(parsed?.updatedAt || ""), 80);
    consultationArticlesCache.lastSuccessAt = normalizeText(String(parsed?.lastSuccessAt || ""), 80);
    consultationArticlesCache.error = normalizeText(String(parsed?.error || ""), 240);
  } catch {
    // keep default fallback content
  }
}

async function persistConsultationArticleCache() {
  await fs.mkdir(path.dirname(CONSULTATION_CACHE_FILE), { recursive: true });
  await fs.writeFile(
    CONSULTATION_CACHE_FILE,
    JSON.stringify(
      {
        items: consultationArticlesCache.items,
        updatedAt: consultationArticlesCache.updatedAt,
        lastSuccessAt: consultationArticlesCache.lastSuccessAt,
        error: consultationArticlesCache.error,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function syncConsultationArticles() {
  if (CONSULTATION_ARTICLE_LINKS.length === 0) {
    consultationArticlesCache.error = "CONSULTATION_ARTICLE_LINKS 未配置，使用默认文章内容";
    return;
  }
  const targetLinks = CONSULTATION_ARTICLE_LINKS.slice(0, CONSULTATION_MAX_ITEMS);
  const results = await Promise.allSettled(targetLinks.map((link) => fetchArticleFromLink(link)));
  const previousByLink = new Map(
    (Array.isArray(consultationArticlesCache.items) ? consultationArticlesCache.items : []).map((item) => [
      item?.link,
      item,
    ]),
  );
  const items = [];
  const errors = [];
  results.forEach((result, index) => {
    const source = targetLinks[index];
    const previousItem = previousByLink.get(source);
    if (result.status === "fulfilled") {
      if (result.value) {
        items.push(result.value);
      } else {
        items.push(buildFallbackArticle(source, previousItem));
      }
      return;
    }
    items.push(buildFallbackArticle(source, previousItem));
    errors.push(`${source}: ${result.reason?.message || "fetch_failed"}`);
  });

  const articles = dedupeAndSortArticles(items);
  if (articles.length > 0) {
    consultationArticlesCache.items = articles;
    const now = new Date().toISOString();
    consultationArticlesCache.updatedAt = now;
    consultationArticlesCache.lastSuccessAt = now;
  }
  consultationArticlesCache.error = errors.join(" | ").slice(0, 240);
  await persistConsultationArticleCache();
}

async function initConsultationArticleSync() {
  await loadConsultationArticleCache();
  if (CONSULTATION_ARTICLE_LINKS.length === 0) return;
  try {
    await syncConsultationArticles();
  } catch (error) {
    console.error("consultation_article_sync_failed", error);
  }
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

async function getFeishuTenantToken() {
  const now = Date.now();
  if (feishuTokenCache.token && now < feishuTokenCache.expiresAtMs) {
    return feishuTokenCache.token;
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    }),
  });

  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`feishu_auth_failed:${data.msg || "unknown"}`);
  }

  const expiresInSeconds = Number(data.expire || 7200);
  feishuTokenCache.token = data.tenant_access_token;
  feishuTokenCache.expiresAtMs = now + Math.max(60, expiresInSeconds - 60) * 1000;
  return feishuTokenCache.token;
}

async function createFeishuRecord(tableId, fields) {
  const token = await getFeishuTenantToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${tableId}/records`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ fields }),
  });

  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`feishu_record_failed:${data.msg || "unknown"}`);
  }
}

async function syncConsultationToFeishu(record) {
  const submittedAtMs = Date.parse(record.createdAt);
  const fields = {
    提交ID: record.id,
    线索类型: "立即咨询",
    姓名: record.name,
    手机号: record.phone,
    意向产品: record.intentionProducts.join("、"),
    提交时间: Number.isFinite(submittedAtMs) ? submittedAtMs : Date.now(),
  };
  await createFeishuRecord(FEISHU_CONSULTATION_TABLE_ID, fields);
}

async function syncPhoneLeadToFeishu(record) {
  const submittedAtMs = Date.parse(record.createdAt);
  const fields = {
    提交ID: record.id,
    线索类型: "预约回电",
    姓名: "",
    手机号: record.phone,
    意向产品: "",
    提交时间: Number.isFinite(submittedAtMs) ? submittedAtMs : Date.now(),
  };
  await createFeishuRecord(FEISHU_PHONE_TABLE_ID, fields);
}

async function handleConsultationSubmit(req, res, url) {
  const clientIp = getClientIp(req);
  const rateLimitKey = `${clientIp}:${url.pathname}`;
  if (isRateLimited(rateLimitKey)) {
    sendJson(res, 429, { ok: false, message: "提交过于频繁，请稍后再试" });
    return;
  }

  const body = await readJsonBody(req);
  const name = normalizeText(body.name, 40);
  const phone = normalizeText(body.phone, 20);
  const sourcePage = normalizeText(body.sourcePage || "unknown", 40) || "unknown";
  const intentionProducts = normalizeProductList(body.intentionProducts);

  if (!name || !isValidPhone(phone) || intentionProducts.length === 0) {
    sendJson(res, 400, { ok: false, message: "参数不合法" });
    return;
  }

  const duplicateKey = `consultation|${phone}|${sourcePage}|${[...intentionProducts].sort().join(",")}`;
  if (hasDuplicateSubmission(duplicateKey)) {
    sendJson(res, 409, { ok: false, message: "请勿重复提交，我们会尽快联系您" });
    return;
  }

  const record = {
    id: randomUUID(),
    name,
    phone,
    sourcePage,
    intentionProducts,
    createdAt: new Date().toISOString(),
  };

  await syncConsultationToFeishu(record);
  markDuplicateSubmission(duplicateKey);
  sendJson(res, 201, { ok: true, message: "提交成功" });
}

async function handlePhoneLeadSubmit(req, res, url) {
  const clientIp = getClientIp(req);
  const rateLimitKey = `${clientIp}:${url.pathname}`;
  if (isRateLimited(rateLimitKey)) {
    sendJson(res, 429, { ok: false, message: "提交过于频繁，请稍后再试" });
    return;
  }

  const body = await readJsonBody(req);
  const phone = normalizeText(body.phone, 20);
  const source = normalizeText(body.source || "unknown", 40) || "unknown";

  if (!isValidPhone(phone)) {
    sendJson(res, 400, { ok: false, message: "手机号不合法" });
    return;
  }

  const duplicateKey = `phone|${phone}|${source}`;
  if (hasDuplicateSubmission(duplicateKey)) {
    sendJson(res, 409, { ok: false, message: "请勿重复提交，我们会尽快联系您" });
    return;
  }

  const record = {
    id: randomUUID(),
    phone,
    source,
    createdAt: new Date().toISOString(),
  };

  await syncPhoneLeadToFeishu(record);
  markDuplicateSubmission(duplicateKey);
  sendJson(res, 201, { ok: true, message: "提交成功" });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      feishuConfigured: hasFeishuConfig(),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/consultation/articles") {
    const shouldRefresh = url.searchParams.get("refresh") === "1";
    if (
      CONSULTATION_ARTICLE_LINKS.length > 0 &&
      (consultationArticlesCache.items.length === 0 || shouldRefresh)
    ) {
      try {
        await syncConsultationArticles();
      } catch (error) {
        console.error("consultation_article_sync_failed", error);
      }
    }
    sendJson(res, 200, {
      ok: true,
      items: consultationArticlesCache.items,
      updatedAt: consultationArticlesCache.updatedAt || consultationArticlesCache.lastSuccessAt || "",
      sourceCount: CONSULTATION_ARTICLE_LINKS.length,
      message: consultationArticlesCache.error || "",
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/leads/consultation") {
    if (!hasFeishuConfig()) {
      sendJson(res, 500, { ok: false, message: "飞书配置缺失，请检查环境变量" });
      return true;
    }
    try {
      await handleConsultationSubmit(req, res, url);
      return true;
    } catch (error) {
      if (error.message === "payload_too_large") {
        sendJson(res, 413, { ok: false, message: "请求体过大" });
        return true;
      }
      if (error.message === "invalid_json") {
        sendJson(res, 400, { ok: false, message: "JSON格式错误" });
        return true;
      }
      console.error("consultation_submit_failed", error);
      sendJson(res, 502, { ok: false, message: mapFeishuErrorMessage(error) });
      return true;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/leads/phone") {
    if (!hasFeishuConfig()) {
      sendJson(res, 500, { ok: false, message: "飞书配置缺失，请检查环境变量" });
      return true;
    }
    try {
      await handlePhoneLeadSubmit(req, res, url);
      return true;
    } catch (error) {
      if (error.message === "payload_too_large") {
        sendJson(res, 413, { ok: false, message: "请求体过大" });
        return true;
      }
      if (error.message === "invalid_json") {
        sendJson(res, 400, { ok: false, message: "JSON格式错误" });
        return true;
      }
      console.error("phone_submit_failed", error);
      sendJson(res, 502, { ok: false, message: mapFeishuErrorMessage(error) });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/leads") {
    sendJson(res, 410, { ok: false, message: "已切换为飞书多维表格存储，请在飞书中查看线索数据" });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/admin/")) {
    sendJson(res, 410, { ok: false, message: "已切换为飞书多维表格存储，请在飞书中查看和筛选数据" });
    return true;
  }

  return false;
}

function resolvePublicPath(urlPathname) {
  const cleanPath = decodeURIComponent(urlPathname).replace(/\/+$/, "") || "/";
  const requested = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const normalized = path.normalize(requested);
  const absolutePath = path.join(WEB_ROOT, normalized);
  if (!absolutePath.startsWith(WEB_ROOT)) return null;
  return absolutePath;
}

async function serveStatic(req, res, url) {
  const filePath = resolvePublicPath(url.pathname);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      sendText(res, 404, "Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "Cache-Control": LONG_CACHE_EXTS.has(ext) ? "public, max-age=604800, immutable" : "no-cache",
    };

    const acceptEncoding = String(req.headers["accept-encoding"] || "");
    const useGzip = COMPRESSIBLE_EXTS.has(ext) && acceptEncoding.includes("gzip");
    if (useGzip) {
      headers["Content-Encoding"] = "gzip";
      headers["Vary"] = "Accept-Encoding";
    }

    res.writeHead(200, headers);
    const fileStream = fsNative.createReadStream(filePath);
    fileStream.on("error", () => {
      if (!res.headersSent) {
        sendText(res, 500, "Server Error");
      } else {
        res.destroy();
      }
    });

    if (useGzip) {
      fileStream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
    } else {
      fileStream.pipe(res);
    }
  } catch {
    sendText(res, 404, "Not Found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const handled = await handleApi(req, res, url);
    if (handled) return;
    await serveStatic(req, res, url);
  } catch {
    sendJson(res, 500, { ok: false, message: "服务端错误" });
  }
});

initConsultationArticleSync().catch((error) => {
  console.error("consultation_article_sync_init_failed", error);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
