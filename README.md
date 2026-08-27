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
- `MSG91_AUTH_KEY` — MSG91 dashboard auth key (server only; never `VITE_*`)
- `MSG91_TEMPLATE_ID` — id from MSG91 dashboard → OTP → Templates (not the TRAI DLT numeric id). The template must include `##OTP##`
- `OTP_SECRET` — long random HMAC key (`openssl rand -hex 32`). Never reuse the MSG91 auth key
- `OTP_EXPIRY_MINUTES` — minutes until the OTP expires (example: `5`; code defaults to `10` if unset)
- `OTP_BYPASS_PHONES` / `OTP_BYPASS_CODE` — optional QA bypass; listed 10-digit numbers skip SMS
- `OTP_DEV_CONSOLE` — `true` prints the OTP to the console (local only; ignored in production)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — super admin login (seeded on first start)
- `ADMIN_SECRET` — optional legacy header for scripts (`x-admin-secret`)
- `CORS_ORIGINS` — optional comma-separated extra frontend origins

The browser never talks to MSG91. This API generates a 6-digit OTP, stores an HMAC hash in Mongo, and sends the digits through MSG91 `GET /api/v5/otp`. Verify compares the hash locally — do not call MSG91’s verify API.

Phone format sent to MSG91: `91` + last 10 digits. Internally everything is stored as 10 digits only.

On startup the server logs whether MongoDB connected. Data is stored in the `niat_awards_2026` database.
