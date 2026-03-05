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
const LEAD_NOTIFICATION_TO = "bestwayservices7@gmail.com";
const SMTP_HOST = (process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_PASS = (process.env.SMTP_PASS || "").trim();
const SMTP_FROM = (process.env.SMTP_FROM || SMTP_USER || "").trim();

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toLine(label, value) {
  return `${label}: ${value && String(value).trim() ? String(value).trim() : "-"}`;
}

function getMissingSmtpEnvVars() {
  const missing = [];

  if (!SMTP_HOST) {
    missing.push("SMTP_HOST");
  }
  if (!SMTP_USER) {
    missing.push("SMTP_USER");
  }
  if (!SMTP_PASS) {
    missing.push("SMTP_PASS");
  }
  if (!SMTP_FROM) {
    missing.push("SMTP_FROM");
  }

  return missing;
}

async function sendLeadNotificationEmail(lead) {
  const missingSmtpVars = getMissingSmtpEnvVars();
  if (missingSmtpVars.length > 0) {
    throw new Error(`Missing SMTP env vars: ${missingSmtpVars.join(", ")}`);
  }

  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  const subject = `[Best Way] New lead from ${lead.source}`;
  const textLines = [
    "New lead received:",
    "",
    toLine("Source", lead.source),
    toLine("Name", lead.name),
    toLine("Email", lead.email),
    toLine("Phone", lead.phone),
    toLine("Cleaning type", lead.cleaningType),
    toLine("Approximate size", lead.size),
    toLine("Location", lead.location),
    toLine("Desired date", lead.desiredDate),
    toLine("Notes", lead.notes),
    toLine("Page path", lead.pagePath),
    toLine("Created at", lead.createdAt),
  ];

  await transporter.sendMail({
    from: SMTP_FROM,
    to: LEAD_NOTIFICATION_TO,
    subject,
    text: textLines.join("\n"),
    html: `
      <h2>New lead received</h2>
      <p><strong>Source:</strong> ${escapeHtml(lead.source)}</p>
      <p><strong>Name:</strong> ${escapeHtml(lead.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(lead.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(lead.phone || "-")}</p>
      <p><strong>Cleaning type:</strong> ${escapeHtml(lead.cleaningType || "-")}</p>
      <p><strong>Approximate size:</strong> ${escapeHtml(lead.size || "-")}</p>
      <p><strong>Location:</strong> ${escapeHtml(lead.location || "-")}</p>
      <p><strong>Desired date:</strong> ${escapeHtml(lead.desiredDate || "-")}</p>
      <p><strong>Notes:</strong> ${escapeHtml(lead.notes || "-")}</p>
      <p><strong>Page path:</strong> ${escapeHtml(lead.pagePath)}</p>
      <p><strong>Created at:</strong> ${escapeHtml(lead.createdAt)}</p>
    `,
  });
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

  if (lead.phone) {
    properties.phone = lead.phone;
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

function send(res, statusCode, payload) {
  res.status(statusCode).setHeader("Cache-Control", "no-store").json(payload);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(res, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  const rawBody = JSON.stringify(req.body || {});
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_SIZE) {
    send(res, 413, { ok: false, error: "Payload too large." });
    return;
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    send(res, 429, { ok: false, error: "Too many requests. Try again later." });
    return;
  }

  const parsed = req.body && typeof req.body === "object" ? req.body : {};

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
  const phone = typeof parsed.phone === "string" ? parsed.phone.trim() : "";
  const cleaningType = typeof parsed.cleaningType === "string" ? parsed.cleaningType.trim() : "";
  const size = typeof parsed.size === "string" ? parsed.size.trim() : "";
  const location = typeof parsed.location === "string" ? parsed.location.trim() : "";
  const desiredDate = typeof parsed.desiredDate === "string" ? parsed.desiredDate.trim() : "";
  const notes = typeof parsed.notes === "string" ? parsed.notes.trim() : "";
  const source = typeof parsed.source === "string" ? parsed.source.trim() : "promo-email";
  const createdAtClient =
    typeof parsed.createdAt === "string" ? parsed.createdAt.trim() : new Date().toISOString();
  const pagePath = typeof parsed.pagePath === "string" ? parsed.pagePath.trim() : "/promo-email/";
  const userAgent =
    typeof parsed.userAgent === "string"
      ? parsed.userAgent.trim()
      : String(req.headers["user-agent"] || "");
  const company = typeof parsed.company === "string" ? parsed.company.trim() : "";

  if (company) {
    send(res, 200, { ok: true });
    return;
  }

  if (name.length < 2) {
    send(res, 400, { ok: false, error: "Please send your name." });
    return;
  }

  if (!emailRegex.test(email)) {
    send(res, 400, { ok: false, error: "Please send a valid email address." });
    return;
  }

  const lead = {
    name,
    email: email.toLowerCase(),
    phone,
    cleaningType,
    size,
    location,
    desiredDate,
    notes,
    source: source || "promo-email",
    createdAt: new Date().toISOString(),
    createdAtClient,
    pagePath,
    userAgent,
    ip,
  };

  console.log("[promo-lead] %s", JSON.stringify(lead));

  try {
    await sendLeadNotificationEmail(lead);
    console.log("[promo-lead] Notification email sent to %s.", LEAD_NOTIFICATION_TO);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[promo-lead] Notification email error: %s", message);
    send(res, 502, { ok: false, error: "Unable to send lead notification right now." });
    return;
  }

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
    send(res, 502, { ok: false, error: "Unable to save your lead right now. Please try again." });
    return;
  }

  send(res, 200, { ok: true, coupon: "BEST10" });
}
