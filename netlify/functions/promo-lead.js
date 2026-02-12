const MAX_BODY_SIZE = 16 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_REQUESTS = 5;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const requestBuckets = new Map();
const HUBSPOT_API_BASE = (process.env.HUBSPOT_API_BASE || "https://api.hubapi.com").replace(
  /\/+$/,
  ""
);
const HUBSPOT_ACCESS_TOKEN = (process.env.HUBSPOT_ACCESS_TOKEN || "").trim();

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

function splitName(name) {
  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { firstName: "", lastName: "" };
  }

  const [firstName, ...rest] = normalized.split(" ");
  return {
    firstName,
    lastName: rest.join(" "),
  };
}

async function getHubSpotErrorMessage(response) {
  const raw = await response.text();
  if (!raw) {
    return `${response.status} ${response.statusText}`.trim();
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed.message || parsed.error || raw;
  } catch (error) {
    return raw;
  }
}

async function callHubSpot(path, method, body) {
  if (!HUBSPOT_ACCESS_TOKEN) {
    return { skipped: true };
  }

  const response = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    skipped: false,
    response,
  };
}

async function syncLeadToHubSpot(lead) {
  if (!HUBSPOT_ACCESS_TOKEN) {
    return { skipped: true };
  }

  const { firstName, lastName } = splitName(lead.name);
  const properties = {
    email: lead.email,
    firstname: firstName,
  };

  if (lastName) {
    properties.lastname = lastName;
  }

  const patchResult = await callHubSpot(
    `/crm/v3/objects/contacts/${encodeURIComponent(lead.email)}?idProperty=email`,
    "PATCH",
    { properties }
  );

  if (patchResult.skipped) {
    return { skipped: true };
  }

  const patchResponse = patchResult.response;
  if (patchResponse.ok) {
    return { skipped: false, action: "updated" };
  }

  if (patchResponse.status !== 404) {
    const errorMessage = await getHubSpotErrorMessage(patchResponse);
    throw new Error(`HubSpot update failed (${patchResponse.status}): ${errorMessage}`);
  }

  const createResult = await callHubSpot("/crm/v3/objects/contacts", "POST", { properties });
  if (createResult.skipped) {
    return { skipped: true };
  }

  const createResponse = createResult.response;
  if (createResponse.ok) {
    return { skipped: false, action: "created" };
  }

  const createError = await getHubSpotErrorMessage(createResponse);
  throw new Error(`HubSpot create failed (${createResponse.status}): ${createError}`);
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

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
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

  if (name.length < 2) {
    return json(400, { ok: false, error: "Please send your name." });
  }

  if (!emailRegex.test(email)) {
    return json(400, { ok: false, error: "Please send a valid email address." });
  }

  const lead = {
    name,
    email: email.toLowerCase(),
    source: source || "promo-email",
    createdAt: new Date().toISOString(),
    createdAtClient,
    pagePath,
    userAgent,
    ip,
  };

  console.log("[promo-lead] %s", JSON.stringify(lead));

  try {
    const hubspotResult = await syncLeadToHubSpot(lead);
    if (hubspotResult.skipped) {
      console.warn(
        "[promo-lead] HubSpot sync skipped because HUBSPOT_ACCESS_TOKEN is not configured."
      );
    } else {
      console.log("[promo-lead] HubSpot contact %s.", hubspotResult.action);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[promo-lead] HubSpot sync error: %s", message);
    return json(502, { ok: false, error: "Unable to save your lead right now. Please try again." });
  }

  // TODO(crm-mailchimp): send `lead` to Mailchimp audience using MAILCHIMP_API_KEY from env.
  // TODO(crm-airtable): persist `lead` to Airtable with AIRTABLE_API_KEY + AIRTABLE_BASE_ID.

  return json(200, { ok: true, coupon: "BEST10" });
};
