const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const WEB_ROOT = path.join(__dirname, "..", "fqgw");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "leads.json");
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

let writeQueue = Promise.resolve();
const rateLimitStore = new Map();

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    const initialData = { consultations: [], phoneLeads: [] };
    await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2), "utf8");
  }
}

async function readData() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return {
    consultations: Array.isArray(parsed.consultations) ? parsed.consultations : [],
    phoneLeads: Array.isArray(parsed.phoneLeads) ? parsed.phoneLeads : [],
  };
}

function updateData(mutator) {
  writeQueue = writeQueue.then(async () => {
    const current = await readData();
    const next = (await mutator(current)) || current;
    await fs.writeFile(DATA_FILE, JSON.stringify(next, null, 2), "utf8");
    return next;
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
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
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
