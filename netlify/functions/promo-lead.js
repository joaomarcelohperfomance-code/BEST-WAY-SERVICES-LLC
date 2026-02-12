const MAX_BODY_SIZE = 16 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_REQUESTS = 5;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const requestBuckets = new Map();

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function getClientIp(event) {
  const forwarded = event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const current = requestBuckets.get(ip) || [];
  const withinWindow = current.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  withinWindow.push(now);
  requestBuckets.set(ip, withinWindow);
  return withinWindow.length > RATE_MAX_REQUESTS;
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {}, { Allow: "POST, OPTIONS" });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed." }, { Allow: "POST" });
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_SIZE) {
    return json(413, { ok: false, error: "Payload too large." });
  }

  const ip = getClientIp(event);
  if (isRateLimited(ip)) {
    return json(429, { ok: false, error: "Too many requests. Try again later." });
  }

  let parsed = {};
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    return json(400, { ok: false, error: "Invalid request body." });
  }

  const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
  const source = typeof parsed.source === "string" ? parsed.source.trim() : "promo-email";
  const createdAtClient =
    typeof parsed.createdAt === "string" ? parsed.createdAt.trim() : new Date().toISOString();
  const pagePath = typeof parsed.pagePath === "string" ? parsed.pagePath.trim() : "/promo-email/";
  const userAgent =
    typeof parsed.userAgent === "string"
      ? parsed.userAgent.trim()
      : String(event.headers["user-agent"] || "");
  const company = typeof parsed.company === "string" ? parsed.company.trim() : "";

  if (company) {
    return json(200, { ok: true });
  }

  if (!emailRegex.test(email)) {
    return json(400, { ok: false, error: "Please send a valid email address." });
  }

  const lead = {
    email: email.toLowerCase(),
    source: source || "promo-email",
    createdAt: new Date().toISOString(),
    createdAtClient,
    pagePath,
    userAgent,
    ip,
  };

  console.log("[promo-lead] %s", JSON.stringify(lead));

  // TODO(crm-hubspot): send `lead` to HubSpot using HUBSPOT_API_KEY from env.
  // TODO(crm-mailchimp): send `lead` to Mailchimp audience using MAILCHIMP_API_KEY from env.
  // TODO(crm-airtable): persist `lead` to Airtable with AIRTABLE_API_KEY + AIRTABLE_BASE_ID.

  return json(200, { ok: true, coupon: "BEST10" });
};
