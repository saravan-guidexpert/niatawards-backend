/**
 * Crop GENERATED unique-teacher portraits with the approved bottom-anchor rule.
 * No OpenAI. No video. Does not overwrite the original local PNG until crop+upload succeed
 * (original local file is never overwritten; cropped files are written beside it).
 *
 * Usage: npx tsx scripts/cropBulkGeneratedPortraits.ts
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { v2 as cloudinary } from "cloudinary";
import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { TeacherPortrait } from "../src/models/TeacherPortrait";

const CONCURRENCY = 5;
const PHOTO_AREA_BOTTOM = 1372;
const WELL_CX = 485;

const BG_REMOVE = path.resolve(__dirname, "../../bg-remove");
const OUT_DIR = path.join(BG_REMOVE, "output", "teacher-portraits");
const CROP_DIR = path.join(OUT_DIR, "cropped");
const REPORT_PATH = path.join(OUT_DIR, "crop-bulk-report.json");
const LOG_PATH = path.join(OUT_DIR, "crop-bulk.log");

type Geometry = {
  scale: number;
  x: number;
  y: number;
  sprite_width: number;
  sprite_height: number;
  visible_bottom: number;
  visible_top: number;
  clear: number;
  opaque255: number;
  size: number[];
  mode: string;
  pixels_unchanged: boolean;
};

const redact = (value: string) =>
  value.replace(/sk-[a-zA-Z0-9_\-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

const log = (line: string) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, `${text}\n`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pythonBin = () => {
  const venv = path.join(BG_REMOVE, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
};

const writeReport = (report: Record<string, unknown>) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
};

const applyCrop = (inputPng: string, outputPng: string): Geometry => {
  const py = spawnSync(
    pythonBin(),
    [path.join(__dirname, "applyApprovedPortraitCrop.py"), inputPng, outputPng],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (py.status !== 0) {
    throw new Error(redact((py.stderr || py.stdout || "crop failed").trim()));
  }
  return JSON.parse(py.stdout || "{}") as Geometry;
};

const validateCrop = (geom: Geometry) => {
  const reasons: string[] = [];
  if (!geom.pixels_unchanged) reasons.push("pixels_changed");
  if (geom.scale !== 1) reasons.push("scale_not_1");
  if (!geom.size || geom.size[0] !== 1080 || geom.size[1] !== 1920) reasons.push("dimensions_not_1080x1920");
  if (geom.mode !== "RGBA") reasons.push("not_rgba");
  if (geom.visible_bottom !== PHOTO_AREA_BOTTOM) reasons.push("bottom_anchor_mismatch");
  if (geom.clear <= 0) reasons.push("background_not_transparent");
  if (geom.opaque255 < 8000) reasons.push("teacher_not_opaque");
  const expectedY = PHOTO_AREA_BOTTOM - geom.sprite_height;
  if (geom.y !== expectedY) reasons.push("y_mismatch");
  if (typeof geom.x !== "number") reasons.push("x_missing");
  return reasons;
};

const cloudinaryErrorMessage = (err: unknown) => {
  if (err instanceof Error && err.message) return redact(err.message);
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const http = rec.http_code || rec.statusCode || rec.status;
    const msg = rec.message || rec.error;
    return redact(`Cloudinary ${http || ""} ${typeof msg === "string" ? msg : JSON.stringify(msg || err)}`.trim());
  }
  return "Cloudinary upload failed";
};

const uploadCropped = async (filePath: string, phone: string) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary is not configured");
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  let lastErr = "Cloudinary upload failed";
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const uploaded = await cloudinary.uploader.upload(filePath, {
        folder: "niat-awards/teacher-portraits",
        public_id: phone,
        resource_type: "image",
        format: "png",
        overwrite: true,
        invalidate: true,
        unique_filename: false,
        use_filename: false,
      });
      if (!uploaded.secure_url) throw new Error("Cloudinary did not return a URL");
      return uploaded.secure_url as string;
    } catch (err) {
      lastErr = cloudinaryErrorMessage(err);
      if (attempt === 3) break;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw new Error(lastErr);
};

const saveCroppedUrl = async (phone: string, url: string, localPath: string) => {
  let lastErr = "Database update failed";
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const updated = await TeacherPortrait.findOneAndUpdate(
        { teacher_phone: phone, portrait_status: "GENERATED" },
        {
          $set: {
            cropped_cloudinary_url: url,
            cropped_local_png_path: localPath,
            portrait_cloudinary_url: url,
            portrait_error: null,
          },
        },
        { new: true }
      );
      if (!updated) throw new Error("TeacherPortrait GENERATED row not found");
      return;
    } catch (err) {
      lastErr = redact(err instanceof Error ? err.message : String(err));
      if (attempt === 3) break;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(lastErr);
};

const main = async () => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) throw new Error("Cloudinary is not configured");
  fs.mkdirSync(CROP_DIR, { recursive: true });
  await connectDB();

  const generated = await TeacherPortrait.find({ portrait_status: "GENERATED" })
    .select("teacher_phone teacher_name portrait_cloudinary_url local_png_path cropped_cloudinary_url cropped_local_png_path")
    .lean();

  const already = generated.filter((row) => String(row.cropped_cloudinary_url || "").trim());
  const remaining = generated.filter((row) => !String(row.cropped_cloudinary_url || "").trim());

  log(`GENERATED TEACHERS = ${generated.length}`);
  log(`ALREADY CROPPED = ${already.length}`);
  log(`REMAINING = ${remaining.length}`);

  const results: Record<string, unknown>[] = already.map((row) => ({
    teacher_phone: row.teacher_phone,
    teacher_name: row.teacher_name,
    cropped_cloudinary_url: row.cropped_cloudinary_url,
    status: "SKIPPED",
  }));

  const counters = {
    cropped_successfully: 0,
    already_cropped_skipped: already.length,
    cloudinary_uploads: 0,
    db_updates: 0,
    failed: 0,
  };

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= remaining.length) return;
      const row = remaining[idx];
      const n = idx + 1;
      const total = remaining.length;
      const phone = String(row.teacher_phone);
      const name = String(row.teacher_name || phone);
      log(`[${String(n).padStart(3, "0")}/${total}] ${name} (${phone})`);
      try {
        const source = String(row.local_png_path || "");
        if (!source || !fs.existsSync(source)) throw new Error("missing local generated PNG");
        const dest = path.join(CROP_DIR, `${phone}.png`);
        const geom = applyCrop(source, dest);
        const reasons = validateCrop(geom);
        if (reasons.length) throw new Error(`validation failed: ${reasons.join(",")}`);
        log(`  cropped x=${geom.x} y=${geom.y} ${geom.sprite_width}x${geom.sprite_height} bottom=${geom.visible_bottom}`);

        let url = "";
        try {
          url = await uploadCropped(dest, phone);
          counters.cloudinary_uploads += 1;
          log("  Cloudinary uploaded");
        } catch (err) {
          throw new Error(`Cloudinary: ${err instanceof Error ? err.message : "upload failed"}`);
        }

        try {
          await saveCroppedUrl(phone, url, dest);
          counters.db_updates += 1;
          log("  DB saved");
        } catch (err) {
          throw new Error(`Database: ${err instanceof Error ? err.message : "update failed"}`);
        }

        counters.cropped_successfully += 1;
        results.push({
          teacher_phone: phone,
          teacher_name: row.teacher_name,
          cropped_cloudinary_url: url,
          status: "CROPPED",
          x: geom.x,
          y: geom.y,
          sprite_width: geom.sprite_width,
          sprite_height: geom.sprite_height,
        });
      } catch (err) {
        counters.failed += 1;
        const message = redact(err instanceof Error ? err.message : String(err));
        log(`  FAILED ${message}`);
        results.push({
          teacher_phone: phone,
          teacher_name: row.teacher_name,
          status: "FAILED",
          error: message,
        });
      }

      writeReport({
        updated_at: new Date().toISOString(),
        total_generated_portraits: generated.length,
        cropped_successfully: counters.cropped_successfully,
        already_cropped_skipped: counters.already_cropped_skipped,
        cloudinary_uploads: counters.cloudinary_uploads,
        db_updates: counters.db_updates,
        failed: counters.failed,
        remaining: remaining.length - (counters.cropped_successfully + counters.failed),
        teachers: results,
      });
    }
  };

  const startedAt = new Date().toISOString();
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, remaining.length)) }, () => worker());
  await Promise.all(workers);

  writeReport({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    total_generated_portraits: generated.length,
    cropped_successfully: counters.cropped_successfully,
    already_cropped_skipped: counters.already_cropped_skipped,
    cloudinary_uploads: counters.cloudinary_uploads,
    db_updates: counters.db_updates,
    failed: counters.failed,
    teachers: results,
  });
  log(
    `DONE cropped=${counters.cropped_successfully} skipped=${counters.already_cropped_skipped} uploads=${counters.cloudinary_uploads} db=${counters.db_updates} failed=${counters.failed}`
  );
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(redact(err instanceof Error ? err.message : String(err)));
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
