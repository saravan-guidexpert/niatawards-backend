import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import express from "express";
import cors from "cors";
import { connectDB } from "./db/connect";
import otpRoutes from "./routes/otp";
import nominationRoutes from "./routes/nominations";
import voteRoutes from "./routes/votes";
import adminRoutes from "./routes/admin";
import uploadRoutes from "./routes/uploads";
import utmRoutes from "./routes/utm";
import funnelRoutes from "./routes/funnel";
import gupshupWebhookRoutes from "./routes/gupshupWebhook";
import cronRoutes from "./routes/cron";
import { seedSuperAdmin } from "./lib/seedSuperAdmin";
import { Nomination } from "./models/Nomination";
import { OtpVerification } from "./models/OtpVerification";

const PORT = Number(process.env.PORT) || 5000;

const ALLOWED_ORIGINS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "https://www.niatawards.in",
  "https://niatawards.in",
  "https://niat-awards.vercel.app",
  "https://niatawards-frontend.vercel.app",
  "https://niatawards-frontend-lac.vercel.app",
];

const extraOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const isAllowedOrigin = (origin?: string) => {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin) || extraOrigins.includes(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    // Vite falls back to 8081, 8082... whenever 8080 is taken, so accept any local port off production.
    if (
      process.env.NODE_ENV !== "production" &&
      (hostname === "localhost" || hostname === "127.0.0.1")
    ) {
      return true;
    }
    if (protocol !== "https:") return false;
    return (
      hostname.endsWith(".vercel.app") &&
      (hostname.includes("niatawards") || hostname.includes("niat-awards"))
    );
  } catch {
    return false;
  }
};

const app = express();
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin ?? undefined));
    },
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-secret"],
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  })
);
app.use(express.json());
// Delivery reports arrive as form-encoded or plain-text bodies, not JSON.
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: ["text/plain", "text/*"] }));

app.use("/webhook/gupshup", gupshupWebhookRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api/otp", otpRoutes);
app.use("/api/nominations", nominationRoutes);
app.use("/api/votes", voteRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/utm", utmRoutes);
app.use("/api/funnel", funnelRoutes);

const start = async () => {
  await connectDB();
  try {
    const indexes = await Nomination.collection.indexes();
    const tokenIndex = indexes.find((idx) => idx.name === "draft_token_1");
    if (tokenIndex?.unique) {
      await Nomination.collection.dropIndex("draft_token_1");
    }
  } catch {
    // index may not exist yet
  }
  try {
    await OtpVerification.collection.dropIndex("phone_1");
  } catch {
    // legacy Karix OTP unique index may already be gone
  }
  try {
    await OtpVerification.deleteMany({ phoneNumber: { $exists: false } });
  } catch {
    // collection may not exist yet
  }
  await seedSuperAdmin();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

start();
