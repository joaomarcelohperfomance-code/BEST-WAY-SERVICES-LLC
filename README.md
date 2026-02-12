# Best Way Services Landing Page

## Hidden Promo Email Page

### Run locally
1. Run `node server.js`
2. Open `http://127.0.0.1:4173/` for the main landing page.
3. Open `http://127.0.0.1:4173/promo-email/` for the hidden capture page.

### What was added
- Hidden route: `/promo-email/` (no link added in main navigation/footer).
- SEO protection on promo page:
  - `<meta name="robots" content="noindex, nofollow">`
  - `X-Robots-Tag: noindex, nofollow` header when served by `server.js`.
- Endpoint: `POST /api/promo-lead` with:
  - Email validation
  - Honeypot field (`company`) validation
  - Basic in-memory rate limiting
  - Server-side logging placeholder for CRM integrations

### Test the POST endpoint
PowerShell example:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:4173/api/promo-lead" `
  -ContentType "application/json" `
  -Body '{"name":"John Smith","email":"cliente@exemplo.com","source":"promo-email","createdAt":"2026-02-12T12:00:00.000Z","pagePath":"/promo-email/","userAgent":"manual-test","company":""}'
```

Expected response:

```json
{"ok":true,"coupon":"BEST10"}
```

### CRM keys integration (TODO hooks)
Replace the placeholder log in `server.js` inside `handlePromoLead`:
- `HUBSPOT_API_KEY`
- `MAILCHIMP_API_KEY`
- `AIRTABLE_API_KEY`
- `AIRTABLE_BASE_ID`

## Deploy on Netlify

### Recommended (Git-based)
1. Push this folder to a GitHub repo.
2. In Netlify: **Add new site** -> **Import an existing project**.
3. Select your repository.
4. Build settings:
   - Build command: *(leave empty)*
   - Publish directory: `.` (root)
5. Deploy.

This project includes:
- `netlify.toml` with:
  - redirect `/api/promo-lead` -> Netlify Function
  - `X-Robots-Tag: noindex, nofollow` for `/promo-email`
- Netlify Function at `netlify/functions/promo-lead.js`

### Production URLs
- Main page: `https://YOUR-SITE.netlify.app/`
- Hidden page: `https://YOUR-SITE.netlify.app/promo-email/`

### Notes
- `server.js` is for local testing only.
- On Netlify, API requests are handled by the function in `netlify/functions/promo-lead.js`.
