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

const PORT = Number(process.env.PORT) || 5000;

const ALLOWED_ORIGINS = [
  "http://localhost:8080",
  "https://www.niatawards.in",
  "https://niatawards.in",
];

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-secret"],
  })
);
app.use(express.json());

app.use("/api/otp", otpRoutes);
app.use("/api/nominations", nominationRoutes);
app.use("/api/votes", voteRoutes);
app.use("/api/admin", adminRoutes);

const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

start();
