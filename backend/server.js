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

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
