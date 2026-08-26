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
- `FAST2SMS_API_KEY` — required for SMS OTP
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — super admin login (seeded on first start)
- `ADMIN_SECRET` — optional legacy header for scripts (`x-admin-secret`)
- `CORS_ORIGINS` — optional comma-separated extra frontend origins

On startup the server logs whether MongoDB connected. Data is stored in the `niat_awards_2026` database.
