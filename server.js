const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const ROOT_DIR = process.cwd();
const MAX_BODY_SIZE = 16 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_REQUESTS = 5;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const requestBuckets = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  const socketAddress = req.socket && req.socket.remoteAddress;
  return typeof socketAddress === "string" ? socketAddress : "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const current = requestBuckets.get(ip) || [];
  const withinWindow = current.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  withinWindow.push(now);
  requestBuckets.set(ip, withinWindow);

  return withinWindow.length > RATE_MAX_REQUESTS;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;
      if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_SIZE) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
      }
    });

    req.on("end", () => {
      resolve(rawBody);
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

function resolveFilePath(routePath) {
  const normalized = path.normalize(routePath).replace(/^(\.\.[/\\])+/, "");
  const resolvedPath = path.resolve(ROOT_DIR, "." + normalized);

  if (!resolvedPath.startsWith(ROOT_DIR)) {
    return null;
  }

  return resolvedPath;
}

function serveFile(res, filePath, extraHeaders = {}) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[extension] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    });
    res.end(content);
  });
}

async function handlePromoLead(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {}, { Allow: "POST, OPTIONS" });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed." }, { Allow: "POST" });
    return;
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    sendJson(res, 429, { ok: false, error: "Too many requests. Try again later." });
    return;
  }

  let parsed;
  try {
    const rawBody = await parseBody(req);
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    if (error instanceof Error && error.message === "PAYLOAD_TOO_LARGE") {
      sendJson(res, 413, { ok: false, error: "Payload too large." });
      return;
    }

    sendJson(res, 400, { ok: false, error: "Invalid request body." });
    return;
  }

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
  const source = typeof parsed.source === "string" ? parsed.source.trim() : "promo-email";
  const createdAtClient =
    typeof parsed.createdAt === "string" ? parsed.createdAt.trim() : new Date().toISOString();
  const pagePath = typeof parsed.pagePath === "string" ? parsed.pagePath.trim() : "";
  const userAgent =
    typeof parsed.userAgent === "string"
      ? parsed.userAgent.trim()
      : String(req.headers["user-agent"] || "");
  const company = typeof parsed.company === "string" ? parsed.company.trim() : "";

  if (company) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (name.length < 2) {
    sendJson(res, 400, { ok: false, error: "Please send your name." });
    return;
  }

  if (!emailRegex.test(email)) {
    sendJson(res, 400, { ok: false, error: "Please send a valid email address." });
    return;
  }

  const lead = {
    name,
    email: email.toLowerCase(),
    source: source || "promo-email",
    createdAt: new Date().toISOString(),
    createdAtClient,
    pagePath: pagePath || "/promo-email/",
    userAgent,
    ip,
  };

  console.log("[promo-lead] %s", JSON.stringify(lead));

  // TODO(crm-hubspot): send `lead` to HubSpot using HUBSPOT_API_KEY from env.
  // TODO(crm-mailchimp): send `lead` to Mailchimp audience using MAILCHIMP_API_KEY from env.
  // TODO(crm-airtable): persist `lead` to Airtable with AIRTABLE_API_KEY + AIRTABLE_BASE_ID.

  sendJson(res, 200, { ok: true, coupon: "BEST10" });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `${HOST}:${PORT}`;
    const requestUrl = new URL(req.url || "/", `http://${host}`);
    const routePath = decodeURIComponent(requestUrl.pathname);

    if (routePath === "/api/promo-lead") {
      await handlePromoLead(req, res);
      return;
    }

    let filePath;
    if (routePath === "/") {
      filePath = path.join(ROOT_DIR, "index.html");
    } else if (routePath === "/promo-email" || routePath === "/promo-email/") {
      filePath = path.join(ROOT_DIR, "promo-email", "index.html");
    } else {
      const resolved = resolveFilePath(routePath);
      if (!resolved) {
        sendJson(res, 400, { ok: false, error: "Bad path." });
        return;
      }

      filePath = resolved;
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
    }

    const extraHeaders = routePath.startsWith("/promo-email")
      ? { "X-Robots-Tag": "noindex, nofollow" }
      : {};

    serveFile(res, filePath, extraHeaders);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: "Internal server error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
