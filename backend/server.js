const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsNative = require("node:fs");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const zlib = require("node:zlib");

const PORT = Number(process.env.PORT || 3000);
const WEB_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const JSON_BACKUP_FILE = path.join(DATA_DIR, "leads.json");
const DB_FILE = path.join(DATA_DIR, "leads.db");
const MAX_BODY_SIZE = 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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

const execFileAsync = promisify(execFile);
let writeQueue = Promise.resolve();
let dbInitPromise = null;
const rateLimitStore = new Map();

function sqlQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function normalizeStorageDataShape(raw) {
  return {
    consultations: Array.isArray(raw?.consultations) ? raw.consultations : [],
    phoneLeads: Array.isArray(raw?.phoneLeads) ? raw.phoneLeads : [],
  };
}

function parseProductArray(value) {
  if (Array.isArray(value)) return normalizeProductList(value);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeProductList(parsed) : [];
  } catch {
    return [];
  }
}

function normalizeConsultationRecord(record) {
  return {
    id: normalizeText(record?.id || "", 100) || randomUUID(),
    name: normalizeText(record?.name || "", 40),
    phone: normalizeText(record?.phone || "", 20),
    intentionProducts: parseProductArray(record?.intentionProducts),
    sourcePage: normalizeText(record?.sourcePage || "unknown", 40) || "unknown",
    createdAt: normalizeText(record?.createdAt || new Date().toISOString(), 40),
  };
}

function normalizePhoneLeadRecord(record) {
  return {
    id: normalizeText(record?.id || "", 100) || randomUUID(),
    phone: normalizeText(record?.phone || "", 20),
    source: normalizeText(record?.source || "unknown", 40) || "unknown",
    createdAt: normalizeText(record?.createdAt || new Date().toISOString(), 40),
  };
}

function normalizeDbData(raw) {
  const shaped = normalizeStorageDataShape(raw);
  return {
    consultations: shaped.consultations.map(normalizeConsultationRecord),
    phoneLeads: shaped.phoneLeads.map(normalizePhoneLeadRecord),
  };
}

async function runSql(sql) {
  await execFileAsync("sqlite3", [DB_FILE, sql]);
}

async function querySql(sql) {
  const { stdout } = await execFileAsync("sqlite3", ["-json", DB_FILE, sql]);
  const text = stdout.trim();
  if (!text) return [];
  return JSON.parse(text);
}

function buildReplaceAllSql(data) {
  const statements = ["BEGIN;", "DELETE FROM consultations;", "DELETE FROM phone_leads;"];

  for (const item of data.consultations) {
    statements.push(
      `INSERT INTO consultations (id, name, phone, intention_products, source_page, created_at) VALUES (${sqlQuote(item.id)}, ${sqlQuote(item.name)}, ${sqlQuote(item.phone)}, ${sqlQuote(JSON.stringify(item.intentionProducts))}, ${sqlQuote(item.sourcePage)}, ${sqlQuote(item.createdAt)});`,
    );
  }

  for (const item of data.phoneLeads) {
    statements.push(
      `INSERT INTO phone_leads (id, phone, source, created_at) VALUES (${sqlQuote(item.id)}, ${sqlQuote(item.phone)}, ${sqlQuote(item.source)}, ${sqlQuote(item.createdAt)});`,
    );
  }

  statements.push("COMMIT;");
  return statements.join("\n");
}

async function replaceAllData(nextData, options = {}) {
  if (!options.skipEnsure) {
    await ensureDatabase();
  }
  const normalized = normalizeDbData(nextData);
  await runSql(buildReplaceAllSql(normalized));
  return normalized;
}

async function migrateFromJsonIfNeeded() {
  const [countRow] = await querySql(
    "SELECT (SELECT COUNT(1) FROM consultations) AS consultationsCount, (SELECT COUNT(1) FROM phone_leads) AS phoneLeadsCount;",
  );
  if (!countRow) return;

  if (Number(countRow.consultationsCount || 0) > 0 || Number(countRow.phoneLeadsCount || 0) > 0) {
    return;
  }

  let raw;
  try {
    raw = await fs.readFile(JSON_BACKUP_FILE, "utf8");
  } catch {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const normalized = normalizeDbData(parsed);
  if (normalized.consultations.length === 0 && normalized.phoneLeads.length === 0) {
    return;
  }

  await replaceAllData(normalized, { skipEnsure: true });
}

async function ensureDatabase() {
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await runSql(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS consultations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  intention_products TEXT NOT NULL,
  source_page TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS phone_leads (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consultations_phone ON consultations(phone);
CREATE INDEX IF NOT EXISTS idx_consultations_created_at ON consultations(created_at);
CREATE INDEX IF NOT EXISTS idx_phone_leads_phone ON phone_leads(phone);
CREATE INDEX IF NOT EXISTS idx_phone_leads_created_at ON phone_leads(created_at);
`);
    await migrateFromJsonIfNeeded();
  })();

  return dbInitPromise;
}

async function readData() {
  await ensureDatabase();
  const consultationsRaw = await querySql(`
SELECT
  id,
  name,
  phone,
  intention_products AS intentionProducts,
  source_page AS sourcePage,
  created_at AS createdAt
FROM consultations
ORDER BY created_at ASC;
`);
  const phoneLeadsRaw = await querySql(`
SELECT
  id,
  phone,
  source,
  created_at AS createdAt
FROM phone_leads
ORDER BY created_at ASC;
`);
  return normalizeDbData({
    consultations: consultationsRaw,
    phoneLeads: phoneLeadsRaw,
  });
}

function updateData(mutator) {
  writeQueue = writeQueue.catch(() => null).then(async () => {
    const current = await readData();
    const currentCopy = structuredClone(current);
    const next = (await mutator(currentCopy)) || currentCopy;
    return replaceAllData(next);
  });
  return writeQueue;
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

function includesText(haystack, keyword) {
  return String(haystack || "").toLowerCase().includes(String(keyword || "").toLowerCase());
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === "") {
    return { value: fallback };
  }
  if (!/^\d+$/.test(String(value))) {
    return { error: "分页参数必须是正整数" };
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    return { error: `分页参数必须在 ${min} 到 ${max} 之间` };
  }
  return { value: parsed };
}

function parseDateQuery(value, fieldName) {
  if (!value) return { value: null };
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) {
    return { error: `${fieldName} 时间格式错误，请使用 ISO 时间格式` };
  }
  return { value: ts };
}

function parseQueryOptions(searchParams) {
  const pageResult = parsePositiveInt(searchParams.get("page"), 1, 1, 1000000);
  if (pageResult.error) return { error: pageResult.error };

  const sizeResult = parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  if (sizeResult.error) return { error: sizeResult.error };

  const startAtRaw = normalizeText(searchParams.get("startAt") || "", 40);
  const endAtRaw = normalizeText(searchParams.get("endAt") || "", 40);

  const startAtResult = parseDateQuery(startAtRaw, "startAt");
  if (startAtResult.error) return { error: startAtResult.error };

  const endAtResult = parseDateQuery(endAtRaw, "endAt");
  if (endAtResult.error) return { error: endAtResult.error };

  if (
    startAtResult.value !== null &&
    endAtResult.value !== null &&
    startAtResult.value > endAtResult.value
  ) {
    return { error: "startAt 不能晚于 endAt" };
  }

  return {
    page: pageResult.value,
    pageSize: sizeResult.value,
    startAtMs: startAtResult.value,
    endAtMs: endAtResult.value,
    startAtRaw: startAtRaw || null,
    endAtRaw: endAtRaw || null,
  };
}

function inTimeRange(createdAt, startAtMs, endAtMs) {
  if (startAtMs === null && endAtMs === null) return true;
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return false;
  if (startAtMs !== null && ts < startAtMs) return false;
  if (endAtMs !== null && ts > endAtMs) return false;
  return true;
}

function sortByCreatedAtDesc(items) {
  return items.sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    const safeA = Number.isFinite(aTime) ? aTime : 0;
    const safeB = Number.isFinite(bTime) ? bTime : 0;
    return safeB - safeA;
  });
}

function paginate(items, page, pageSize) {
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const safePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const pagedItems = items.slice(offset, offset + pageSize);

  return {
    page: safePage,
    pageSize,
    total,
    totalPages,
    hasPrev: safePage > 1 && totalPages > 0,
    hasNext: safePage < totalPages,
    items: pagedItems,
  };
}

function toTopList(map, keyName) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((a, b) => b.count - a.count);
}

function countToday(records, now = Date.now()) {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return records.filter((record) => {
    const ts = Date.parse(record.createdAt);
    return Number.isFinite(ts) && ts >= start && ts <= now;
  }).length;
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

function happenedWithinWindow(isoTime, now, windowMs) {
  const ts = Date.parse(isoTime);
  if (!Number.isFinite(ts)) return false;
  return now - ts <= windowMs;
}

function sameProductSet(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((item, index) => item === sortedB[index]);
}

function isDuplicateConsultation(records, incoming, now) {
  return records.some(
    (record) =>
      record.phone === incoming.phone &&
      record.sourcePage === incoming.sourcePage &&
      happenedWithinWindow(record.createdAt, now, DUPLICATE_WINDOW_MS) &&
      sameProductSet(record.intentionProducts || [], incoming.intentionProducts),
  );
}

function isDuplicatePhoneLead(records, incoming, now) {
  return records.some(
    (record) =>
      record.phone === incoming.phone &&
      record.source === incoming.source &&
      happenedWithinWindow(record.createdAt, now, DUPLICATE_WINDOW_MS),
  );
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
        const body = raw ? JSON.parse(raw) : {};
        resolve(body);
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/leads/consultation") {
    try {
      const clientIp = getClientIp(req);
      const rateLimitKey = `${clientIp}:${url.pathname}`;
      if (isRateLimited(rateLimitKey)) {
        sendJson(res, 429, {
          ok: false,
          message: "提交过于频繁，请稍后再试",
        });
        return true;
      }

      const body = await readJsonBody(req);
      const name = normalizeText(body.name, 40);
      const phone = normalizeText(body.phone, 20);
      const sourcePage = normalizeText(body.sourcePage || "unknown", 40);
      const intentionProducts = normalizeProductList(body.intentionProducts);

      if (!name || !isValidPhone(phone) || intentionProducts.length === 0) {
        sendJson(res, 400, { ok: false, message: "参数不合法" });
        return true;
      }

      const record = {
        id: randomUUID(),
        name,
        phone,
        intentionProducts,
        sourcePage,
        createdAt: new Date().toISOString(),
      };

      let duplicated = false;
      const now = Date.now();
      await updateData((data) => {
        if (isDuplicateConsultation(data.consultations, record, now)) {
          duplicated = true;
          return data;
        }
        data.consultations.push(record);
        return data;
      });

      if (duplicated) {
        sendJson(res, 409, { ok: false, message: "请勿重复提交，我们会尽快联系您" });
        return true;
      }

      sendJson(res, 201, { ok: true, message: "提交成功" });
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
      sendJson(res, 500, { ok: false, message: "服务端错误" });
      return true;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/leads/phone") {
    try {
      const clientIp = getClientIp(req);
      const rateLimitKey = `${clientIp}:${url.pathname}`;
      if (isRateLimited(rateLimitKey)) {
        sendJson(res, 429, {
          ok: false,
          message: "提交过于频繁，请稍后再试",
        });
        return true;
      }

      const body = await readJsonBody(req);
      const phone = normalizeText(body.phone, 20);
      const source = normalizeText(body.source || "unknown", 40);

      if (!isValidPhone(phone)) {
        sendJson(res, 400, { ok: false, message: "手机号不合法" });
        return true;
      }

      const record = {
        id: randomUUID(),
        phone,
        source,
        createdAt: new Date().toISOString(),
      };

      let duplicated = false;
      const now = Date.now();
      await updateData((data) => {
        if (isDuplicatePhoneLead(data.phoneLeads, record, now)) {
          duplicated = true;
          return data;
        }
        data.phoneLeads.push(record);
        return data;
      });

      if (duplicated) {
        sendJson(res, 409, { ok: false, message: "请勿重复提交，我们会尽快联系您" });
        return true;
      }

      sendJson(res, 201, { ok: true, message: "提交成功" });
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
      sendJson(res, 500, { ok: false, message: "服务端错误" });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/leads") {
    const data = await readData();
    sendJson(res, 200, {
      ok: true,
      consultationsCount: data.consultations.length,
      phoneLeadsCount: data.phoneLeads.length,
      consultations: data.consultations.slice(-50).reverse(),
      phoneLeads: data.phoneLeads.slice(-50).reverse(),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/leads/consultations") {
    const options = parseQueryOptions(url.searchParams);
    if (options.error) {
      sendJson(res, 400, { ok: false, message: options.error });
      return true;
    }

    const phone = normalizeText(url.searchParams.get("phone") || "", 20);
    const name = normalizeText(url.searchParams.get("name") || "", 40);
    const sourcePage = normalizeText(url.searchParams.get("sourcePage") || "", 40);
    const product = normalizeText(url.searchParams.get("product") || "", 30);

    const data = await readData();
    const filtered = sortByCreatedAtDesc(
      data.consultations.filter((record) => {
        if (phone && !includesText(record.phone, phone)) return false;
        if (name && !includesText(record.name, name)) return false;
        if (sourcePage && !includesText(record.sourcePage, sourcePage)) return false;
        if (product && !(Array.isArray(record.intentionProducts) && record.intentionProducts.includes(product))) {
          return false;
        }
        if (!inTimeRange(record.createdAt, options.startAtMs, options.endAtMs)) return false;
        return true;
      }),
    );

    const pageData = paginate(filtered, options.page, options.pageSize);
    sendJson(res, 200, {
      ok: true,
      filters: {
        phone: phone || null,
        name: name || null,
        sourcePage: sourcePage || null,
        product: product || null,
        startAt: options.startAtRaw,
        endAt: options.endAtRaw,
      },
      pagination: {
        page: pageData.page,
        pageSize: pageData.pageSize,
        total: pageData.total,
        totalPages: pageData.totalPages,
        hasPrev: pageData.hasPrev,
        hasNext: pageData.hasNext,
      },
      items: pageData.items,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/leads/phones") {
    const options = parseQueryOptions(url.searchParams);
    if (options.error) {
      sendJson(res, 400, { ok: false, message: options.error });
      return true;
    }

    const phone = normalizeText(url.searchParams.get("phone") || "", 20);
    const source = normalizeText(url.searchParams.get("source") || "", 40);

    const data = await readData();
    const filtered = sortByCreatedAtDesc(
      data.phoneLeads.filter((record) => {
        if (phone && !includesText(record.phone, phone)) return false;
        if (source && !includesText(record.source, source)) return false;
        if (!inTimeRange(record.createdAt, options.startAtMs, options.endAtMs)) return false;
        return true;
      }),
    );

    const pageData = paginate(filtered, options.page, options.pageSize);
    sendJson(res, 200, {
      ok: true,
      filters: {
        phone: phone || null,
        source: source || null,
        startAt: options.startAtRaw,
        endAt: options.endAtRaw,
      },
      pagination: {
        page: pageData.page,
        pageSize: pageData.pageSize,
        total: pageData.total,
        totalPages: pageData.totalPages,
        hasPrev: pageData.hasPrev,
        hasNext: pageData.hasNext,
      },
      items: pageData.items,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/leads/summary") {
    const data = await readData();
    const consultationSourceMap = new Map();
    const phoneSourceMap = new Map();
    const productMap = new Map();

    for (const record of data.consultations) {
      const sourcePage = record.sourcePage || "unknown";
      consultationSourceMap.set(sourcePage, (consultationSourceMap.get(sourcePage) || 0) + 1);

      const products = Array.isArray(record.intentionProducts) ? record.intentionProducts : [];
      for (const product of products) {
        productMap.set(product, (productMap.get(product) || 0) + 1);
      }
    }

    for (const record of data.phoneLeads) {
      const source = record.source || "unknown";
      phoneSourceMap.set(source, (phoneSourceMap.get(source) || 0) + 1);
    }

    sendJson(res, 200, {
      ok: true,
      totals: {
        consultations: data.consultations.length,
        phoneLeads: data.phoneLeads.length,
      },
      today: {
        consultations: countToday(data.consultations),
        phoneLeads: countToday(data.phoneLeads),
      },
      top: {
        consultationBySourcePage: toTopList(consultationSourceMap, "sourcePage"),
        phoneLeadBySource: toTopList(phoneSourceMap, "source"),
        consultationByProduct: toTopList(productMap, "product"),
      },
    });
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
      const gzipStream = zlib.createGzip({ level: 6 });
      fileStream.pipe(gzipStream).pipe(res);
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
  } catch (error) {
    sendJson(res, 500, { ok: false, message: "服务端错误" });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
