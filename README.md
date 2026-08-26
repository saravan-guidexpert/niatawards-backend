# niatawards-backend

Express + TypeScript + MongoDB API for NIAT Educator Awards 2026.

```bash
npm install
npm run dev
```

API: http://localhost:5000

Copy `.env.example` to `.env` and set:

- `MONGODB_URI` — MongoDB Atlas connection string
- `PORT` — defaults to `5000`
- `KARIX_ACCESS_KEY` — Karix API key
- `KARIX_SENDER_ID` — DLT sender ID registered with Karix
- `KARIX_QS_URL` — defaults to `https://japi.instaalerts.zone/httpapi/QueryStringReceiver`
- `KARIX_OTP_TEXT` — SMS body, quoted; must match the approved DLT template exactly, with `{#var#}` where the code goes
- `KARIX_OTP_EXPIRY` — minutes until the OTP expires (default `5`)
- `KARIX_DLT_TEMPLATE_ID` / `KARIX_DLT_ENTITY_ID` / `KARIX_DLT_TM_ID` — DLT ids; required for Indian traffic
- `OTP_DEV_CONSOLE` — `true` prints the OTP and outbound request to the console (local only)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — super admin login (seeded on first start)
- `ADMIN_SECRET` — optional legacy header for scripts (`x-admin-secret`)
- `CORS_ORIGINS` — optional comma-separated extra frontend origins

Phone `9123456789` with OTP `000000` bypasses Karix for local testing.

OTPs go out over Karix's QueryString receiver. Its JSON receivers (`japi` and `pod3`)
answer `200 Request accepted` on this account and then silently drop the message, so
don't switch transports without re-testing actual delivery to a handset.

On startup the server logs whether MongoDB connected. Data is stored in the `niat_awards_2026` database.
