/**
 * Bulk unique-teacher portraits: one gpt-image-2 portrait per teacher phone.
 * Variant 5 composition. No videos, no messages.
 *
 * Usage: npx tsx scripts/bulkGenerateUniqueTeacherPortraits.ts
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import OpenAI, { toFile, APIError } from "openai";
import { v2 as cloudinary } from "cloudinary";
import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { Nomination } from "../src/models/Nomination";
import { NominationVideo } from "../src/models/NominationVideo";
import { TeacherPortrait } from "../src/models/TeacherPortrait";
import { namesCompatible } from "../src/lib/resolveTeacherPortrait";

const MODEL = "gpt-image-2";
const CONCURRENCY = 5;
const MAX_RETRIES = 2;
const TEST_NOMINATION_ID = "1c4e6b10-03a4-4141-ad08-7ef7339c17f5";

const BG_REMOVE = path.resolve(__dirname, "../../bg-remove");
const OUT_DIR = path.join(BG_REMOVE, "output", "teacher-portraits");
const PHONE_DIR = path.join(OUT_DIR, "by-phone");
const REPORT_PATH = path.join(OUT_DIR, "bulk-unique-teacher-report.json");
const LOG_PATH = path.join(OUT_DIR, "bulk-unique-teacher.log");

const PORTRAIT_PROMPT = [
  "IMAGE 1 is the identity source photograph of one specific real teacher. Recreate THIS exact person.",
  "Create a premium photorealistic professional studio portrait of the exact same individual.",
  "Preserve exactly: facial structure, face shape, forehead, jawline, cheeks, chin, nose, eyes, eyebrows, lips, ears, hairline, hairstyle, hair texture, skin tone, natural skin texture, facial asymmetry, moles/marks, age, expression, exact clothing, clothing colors, clothing pattern, jewelry, existing accessories.",
  "Do not create a lookalike. Do not redesign the face. Do not beautify. Do not make the person younger. Do not change skin tone, hairstyle, clothing, or jewelry. Do not add or remove accessories.",
  "The source may be a selfie, screenshot, or poorly framed photo. Do not paste a cutout selfie. Photograph the same person as a waist-up standing studio portrait with an 85mm full-frame look, large soft key light, subtle fill, realistic skin, hair, and fabric.",
  "Complete natural shoulders and upper torso consistent with the existing body and clothing. Do not invent a different outfit.",
  "Vertical 1088x1920 canvas. Teacher only on a fully transparent background. The silhouette must not touch the left, right, or bottom edges. Leave transparent margin. No white, gray, orange, black backdrop, room, wall, Instagram UI, halo, drop shadow, glow, text, or template graphics.",
].join(" ");

type Nom = {
  _id: string;
  teacher_name?: string | null;
  phone?: string | null;
  photo_url?: string | null;
  created_at?: Date | string | null;
};

type TeacherGroup = {
  phone: string;
  name: string;
  nominations: Nom[];
};

const phone10 = (value: unknown) => String(value ?? "").replace(/\D/g, "").slice(-10);

const isPlaceholderPhone = (phone: string) => /^(\d)\1{9}$/.test(phone);

const redact = (value: string) =>
  value.replace(/sk-[a-zA-Z0-9_\-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

const log = (line: string) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, `${text}\n`);
};

const pythonBin = () => {
  const venv = path.join(BG_REMOVE, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
};

const publicApiError = (err: unknown) => {
  if (err instanceof APIError) {
    return {
      http_status: err.status ?? null,
      openai_error: redact(err.message || ""),
      code: err.code ? String(err.code) : null,
      retryable: err.status === 429 || (err.status ?? 0) >= 500,
    };
  }
  const message = redact(err instanceof Error ? err.message : String(err));
  return {
    http_status: null,
    openai_error: message,
    code: null,
    retryable: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(message),
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const mapAdminStatus = (status: string) => {
  if (status === "GENERATED") return "READY";
  if (status === "PENDING") return "NOT_STARTED";
  return status;
};

const writeReport = (report: Record<string, unknown>) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
};

const downloadPhoto = async (photoUrl: string, destBase: string) => {
  const res = await fetch(photoUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Failed to download photo_url (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim();
  const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
  const dest = `${destBase}${ext}`;
  fs.writeFileSync(dest, buf);
  return { dest, contentType: contentType || "image/jpeg", bytes: buf.length };
};

const scoreSource = (filePath: string) => {
  const py = spawnSync(
    pythonBin(),
    [
      "-c",
      "from PIL import Image, ImageOps\nimport sys\nim=ImageOps.exif_transpose(Image.open(sys.argv[1]))\nw,h=im.size\naspect=h/max(1,w)\nscreenshot=1 if aspect>2.05 else 0\nprint(f'{w} {h} {w*h} {aspect:.4f} {screenshot}')",
      filePath,
    ],
    { encoding: "utf8" }
  );
  if (py.status !== 0) return { pixels: 0, screenshot: 1, w: 0, h: 0 };
  const [w, h, pixels, aspect, screenshot] = (py.stdout || "").trim().split(/\s+/);
  return {
    w: Number(w) || 0,
    h: Number(h) || 0,
    pixels: Number(pixels) || 0,
    aspect: Number(aspect) || 0,
    screenshot: Number(screenshot) || 0,
  };
};

const pickSource = async (group: TeacherGroup, workDir: string) => {
  const sorted = [...group.nominations].sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return ta - tb;
  });
  const unique = new Map<string, Nom>();
  for (const n of sorted) {
    const url = String(n.photo_url || "").trim();
    if (!url) continue;
    if (group.name && !namesCompatible(n.teacher_name, group.name)) continue;
    if (!unique.has(url)) unique.set(url, n);
  }
  const candidates = [...unique.values()];
  if (!candidates.length) throw new Error("No photo_url");
  if (candidates.length === 1) {
    const n = candidates[0];
    const downloaded = await downloadPhoto(String(n.photo_url), path.join(workDir, "source"));
    return { nomination: n, ...downloaded, reason: "only_photo" };
  }
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const n = candidates[i];
    try {
      const downloaded = await downloadPhoto(String(n.photo_url), path.join(workDir, `source-${i}`));
      const meta = scoreSource(downloaded.dest);
      const score = meta.pixels * (meta.screenshot ? 0.55 : 1) - i * 10;
      scored.push({ nomination: n, ...downloaded, ...meta, score });
    } catch {
      continue;
    }
  }
  if (!scored.length) throw new Error("All candidate photos failed to download");
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return { ...best, reason: "highest_resolution_least_screenshot" };
};

const applyVariant5 = (inputPng: string, outputPng: string) => {
  const py = spawnSync(
    pythonBin(),
    [path.join(__dirname, "applyVariant5Portrait.py"), inputPng, outputPng],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (py.status !== 0) throw new Error(py.stderr || "Variant 5 compose failed");
  return JSON.parse(py.stdout || "{}");
};

const inspectPortrait = (pngPath: string) => {
  const py = spawnSync(
    pythonBin(),
    [
      "-c",
      [
        "from PIL import Image",
        "import json,sys",
        "im=Image.open(sys.argv[1]).convert('RGBA')",
        "a=im.split()[-1]; hist=a.histogram(); bbox=a.point(lambda p: 255 if p>=16 else 0).getbbox()",
        "total=im.size[0]*im.size[1]; clear=hist[0]; a255=hist[255]",
        "print(json.dumps({'w':im.size[0],'h':im.size[1],'mode':im.mode,'clear':clear,'opaque255':a255,'partial':total-clear-a255,'bbox':list(bbox) if bbox else None}))",
      ].join("\n"),
      pngPath,
    ],
    { encoding: "utf8" }
  );
  if (py.status !== 0) throw new Error(py.stderr || "inspect failed");
  return JSON.parse(py.stdout || "{}") as {
    w: number;
    h: number;
    clear: number;
    opaque255: number;
    partial: number;
    bbox: number[] | null;
  };
};

const validatePortrait = (info: ReturnType<typeof inspectPortrait>, geometry: Record<string, unknown>) => {
  const reasons: string[] = [];
  if (info.w !== 1080 || info.h !== 1920) reasons.push("dimensions_not_1080x1920");
  if (info.clear <= 0) reasons.push("background_not_transparent");
  if (info.opaque255 < 8000) reasons.push("teacher_not_opaque");
  const geom = (geometry.geometry || geometry) as { x?: number; y?: number; w?: number; h?: number };
  if (typeof geom.y === "number" && Math.abs(geom.y - 378) > 8) reasons.push("variant5_y_mismatch");
  if (typeof geom.x === "number" && (geom.x < 220 || geom.x > 280)) reasons.push("variant5_x_mismatch");
  if (info.partial > info.opaque255 * 0.08) reasons.push("excess_partial_alpha");
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

const uploadPortrait = async (filePath: string, phone: string) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary is not configured");
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  let lastErr = "Cloudinary upload failed";
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const uploaded = await cloudinary.uploader.upload(filePath, {
        folder: "niat-awards/teacher-portraits",
        public_id: phone,
        resource_type: "image",
        format: "png",
        overwrite: true,
        unique_filename: false,
        use_filename: false,
      });
      if (!uploaded.secure_url) throw new Error("Cloudinary did not return a URL");
      return uploaded.secure_url as string;
    } catch (err) {
      lastErr = cloudinaryErrorMessage(err);
      if (attempt === 2) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error(lastErr);
};

const generateImage = async (client: OpenAI, sourcePath: string, contentType: string, destRaw: string) => {
  const identity = await toFile(fs.createReadStream(sourcePath), path.basename(sourcePath), {
    type: contentType,
  });
  let lastErr: ReturnType<typeof publicApiError> | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.images.edit({
        model: MODEL,
        image: identity,
        prompt: PORTRAIT_PROMPT,
        background: "transparent",
        quality: "high",
        n: 1,
        size: "1088x1920" as "1024x1536",
      });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) throw new Error("images.edit returned no b64_json");
      fs.writeFileSync(destRaw, Buffer.from(b64, "base64"));
      return;
    } catch (err) {
      lastErr = publicApiError(err);
      if (!lastErr.retryable || attempt === MAX_RETRIES) {
        throw new Error(lastErr.openai_error || "image generation failed");
      }
      await sleep(15000 * (attempt + 1));
    }
  }
  throw new Error(lastErr?.openai_error || "image generation failed");
};

const fanoutUrl = async (group: TeacherGroup, url: string) => {
  const ids = group.nominations.map((n) => n._id);
  for (const nominationId of ids) {
    await NominationVideo.findOneAndUpdate(
      { nomination_id: nominationId },
      {
        $set: { portrait_cloudinary_url: url },
        $setOnInsert: {
          nomination_id: nominationId,
          generation_status: "pending",
          review_status: "none",
          ready_for_message: false,
        },
      },
      { upsert: true }
    );
  }
};

const main = async () => {
  const apiKey = String(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  const baseURL = String(
    process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.openai.com/v1"
  ).trim();
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
  if (!process.env.CLOUDINARY_CLOUD_NAME) throw new Error("Cloudinary is not configured");

  fs.mkdirSync(PHONE_DIR, { recursive: true });
  await connectDB();

  const eligible = await Nomination.find({ type: "student", status: { $ne: "draft" } })
    .select("_id teacher_name phone photo_url created_at")
    .lean();

  const byPhone = new Map<string, TeacherGroup>();
  for (const n of eligible as Nom[]) {
    const phone = phone10(n.phone);
    if (phone.length !== 10 || isPlaceholderPhone(phone)) continue;
    const existing = byPhone.get(phone);
    const name = String(n.teacher_name || "").trim();
    if (existing) {
      existing.nominations.push(n);
      if (name && !existing.name) existing.name = name;
    } else {
      byPhone.set(phone, { phone, name, nominations: [n] });
    }
  }

  const withPhoto: TeacherGroup[] = [];
  const withoutPhoto: TeacherGroup[] = [];
  for (const group of byPhone.values()) {
    const has = group.nominations.some((n) => String(n.photo_url || "").trim());
    if (has) withPhoto.push(group);
    else withoutPhoto.push(group);
  }
  withPhoto.sort((a, b) => a.phone.localeCompare(b.phone));

  const existing = await TeacherPortrait.find({
    teacher_phone: { $in: withPhoto.map((g) => g.phone) },
  }).lean();
  const existingByPhone = new Map(existing.map((row) => [row.teacher_phone, row]));

  const testNom = eligible.find((n) => n._id === TEST_NOMINATION_ID) as Nom | undefined;
  const testPhone = testNom ? phone10(testNom.phone) : "";
  if (testPhone.length === 10) {
    const testVideo = await NominationVideo.findOne({ nomination_id: TEST_NOMINATION_ID }).lean();
    const local = path.join(OUT_DIR, `${TEST_NOMINATION_ID}.png`);
    if (testVideo?.portrait_cloudinary_url && fs.existsSync(local)) {
      await TeacherPortrait.findOneAndUpdate(
        { teacher_phone: testPhone },
        {
          $set: {
            teacher_name: String(testNom?.teacher_name || "").trim() || null,
            source_nomination_id: TEST_NOMINATION_ID,
            source_photo_url: testNom?.photo_url || null,
            portrait_cloudinary_url: testVideo.portrait_cloudinary_url,
            portrait_status: "GENERATED",
            portrait_error: null,
            local_png_path: local,
          },
          $setOnInsert: { teacher_phone: testPhone },
        },
        { upsert: true }
      );
      const group = byPhone.get(testPhone);
      if (group) await fanoutUrl(group, String(testVideo.portrait_cloudinary_url));
      existingByPhone.set(testPhone, {
        teacher_phone: testPhone,
        portrait_cloudinary_url: testVideo.portrait_cloudinary_url,
        portrait_status: "GENERATED",
      } as never);
    }
  }

  const already = withPhoto.filter((g) => {
    const row = existingByPhone.get(g.phone);
    return row?.portrait_status === "GENERATED" && String(row.portrait_cloudinary_url || "").trim();
  });
  const remaining = withPhoto.filter((g) => !already.some((a) => a.phone === g.phone));

  log(`Unique eligible teachers: ${byPhone.size}`);
  log(`Unique eligible teachers with photos: ${withPhoto.length}`);
  log(`Already generated: ${already.length}`);
  log(`Remaining: ${remaining.length}`);
  log(`Teachers without photos: ${withoutPhoto.length}`);

  const results: Record<string, unknown>[] = already.map((g) => {
    const row = existingByPhone.get(g.phone);
    return {
      teacher_phone: g.phone,
      teacher_name: g.name,
      source_nomination_id: row?.source_nomination_id || null,
      portrait_cloudinary_url: row?.portrait_cloudinary_url || null,
      status: "GENERATED",
      skipped_existing: true,
    };
  });

  const counters = {
    generated: already.length,
    skipped_existing: already.length,
    needs_review: 0,
    failed: 0,
    cloudinary_failures: 0,
    database_failures: 0,
  };

  const client = new OpenAI({ apiKey, baseURL, timeout: 240000, maxRetries: 0 });
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= remaining.length) return;
      const group = remaining[idx];
      const n = idx + 1;
      const total = remaining.length;
      const workDir = path.join(PHONE_DIR, group.phone);
      fs.mkdirSync(workDir, { recursive: true });
      const outPng = path.join(PHONE_DIR, `${group.phone}.png`);
      const rawPng = path.join(workDir, "gpt-raw.png");

      log(`[${String(n).padStart(3, "0")}/${total}] ${group.name || group.phone}`);

      try {
        await TeacherPortrait.findOneAndUpdate(
          { teacher_phone: group.phone },
          {
            $set: {
              teacher_name: group.name || null,
              portrait_status: "PROCESSING",
              portrait_error: null,
            },
            $setOnInsert: { teacher_phone: group.phone },
          },
          { upsert: true }
        );
        const source = await pickSource(group, workDir);
        log(`  source ${source.nomination._id} (${source.reason})`);
        let geometry: unknown = null;
        const reusableLocal = (() => {
          if (!fs.existsSync(outPng)) return false;
          try {
            const existing = inspectPortrait(outPng);
            return existing.w === 1080 && existing.h === 1920 && existing.clear > 100000;
          } catch {
            return false;
          }
        })();
        if (reusableLocal) {
          log("  reusing existing local PNG");
        } else {
          await generateImage(client, source.dest, source.contentType, rawPng);
          log("  image generated");
          geometry = applyVariant5(rawPng, outPng);
        }
        const info = inspectPortrait(outPng);
        const failReasons = validatePortrait(info, (geometry || {}) as Record<string, unknown>);
        const needsReview = failReasons.length > 0;
        if (needsReview) log(`  validation NEEDS_REVIEW ${failReasons.join(",")}`);
        else log("  validated");

        let cloudinaryUrl = "";
        try {
          cloudinaryUrl = await uploadPortrait(outPng, group.phone);
          log("  Cloudinary uploaded");
        } catch (err) {
          counters.cloudinary_failures += 1;
          throw new Error(err instanceof Error ? err.message : "Cloudinary upload failed");
        }

        try {
          await TeacherPortrait.findOneAndUpdate(
            { teacher_phone: group.phone },
            {
              $set: {
                teacher_name: group.name || null,
                source_nomination_id: source.nomination._id,
                source_photo_url: source.nomination.photo_url || null,
                portrait_cloudinary_url: cloudinaryUrl,
                portrait_status: needsReview ? "NEEDS_REVIEW" : "GENERATED",
                portrait_error: needsReview ? failReasons.join("; ") : null,
                local_png_path: outPng,
              },
            }
          );
          await fanoutUrl(group, cloudinaryUrl);
          log("  DB saved");
        } catch (err) {
          counters.database_failures += 1;
          throw new Error(err instanceof Error ? err.message : "Database update failed");
        }

        if (needsReview) counters.needs_review += 1;
        else counters.generated += 1;
        results.push({
          teacher_phone: group.phone,
          teacher_name: group.name,
          source_nomination_id: source.nomination._id,
          source_photo_url: source.nomination.photo_url,
          portrait_cloudinary_url: cloudinaryUrl,
          status: needsReview ? "NEEDS_REVIEW" : "GENERATED",
          validation_reasons: failReasons,
        });
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err));
        counters.failed += 1;
        log(`  FAILED ${message}`);
        try {
          await TeacherPortrait.findOneAndUpdate(
            { teacher_phone: group.phone },
            {
              $set: {
                teacher_name: group.name || null,
                portrait_status: "FAILED",
                portrait_error: message.slice(0, 2000),
              },
              $setOnInsert: { teacher_phone: group.phone },
            },
            { upsert: true }
          );
        } catch (saveErr) {
          counters.database_failures += 1;
          log(`  FAILED to record error ${redact(saveErr instanceof Error ? saveErr.message : String(saveErr))}`);
        }
        results.push({
          teacher_phone: group.phone,
          teacher_name: group.name,
          status: "FAILED",
          reason: message,
          timestamp: new Date().toISOString(),
        });
      }

      writeReport({
        started_at: startedAt,
        updated_at: new Date().toISOString(),
        total_eligible_student_nominations: eligible.length,
        total_unique_teachers: byPhone.size,
        unique_teachers_with_photo: withPhoto.length,
        unique_teachers_without_photo: withoutPhoto.length,
        generated: counters.generated,
        skipped_existing: counters.skipped_existing,
        needs_review: counters.needs_review,
        failed: counters.failed,
        cloudinary_failures: counters.cloudinary_failures,
        database_failures: counters.database_failures,
        remaining: remaining.length - (counters.generated + counters.needs_review + counters.failed - already.length),
        teachers: results,
      });
    }
  };

  const startedAt = new Date().toISOString();
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, remaining.length)) }, () => worker());
  await Promise.all(workers);

  const finishedAt = new Date().toISOString();
  writeReport({
    started_at: startedAt,
    finished_at: finishedAt,
    total_eligible_student_nominations: eligible.length,
    total_unique_teachers: byPhone.size,
    unique_teachers_with_photo: withPhoto.length,
    unique_teachers_without_photo: withoutPhoto.length,
    generated: counters.generated,
    skipped_existing: counters.skipped_existing,
    needs_review: counters.needs_review,
    failed: counters.failed,
    cloudinary_failures: counters.cloudinary_failures,
    database_failures: counters.database_failures,
    teachers: results,
  });
  log(`DONE generated=${counters.generated} skipped=${counters.skipped_existing} needs_review=${counters.needs_review} failed=${counters.failed}`);
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(redact(err instanceof Error ? err.message : String(err)));
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
