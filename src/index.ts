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
import { seedSuperAdmin } from "./lib/seedSuperAdmin";

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

app.use("/api/otp", otpRoutes);
app.use("/api/nominations", nominationRoutes);
app.use("/api/votes", voteRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/utm", utmRoutes);
app.use("/api/funnel", funnelRoutes);

const start = async () => {
  await connectDB();
  await seedSuperAdmin();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

start();
