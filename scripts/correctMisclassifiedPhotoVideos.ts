/**
 * Correct videos that have Nomination.photo_url but were rendered as without_photo.
 * Portrait source is THIS nomination's photo_url only. No phone-based photo picking.
 * Does not send messages. Default LIMIT=3 (verification). Include Anas Khan.
 *
 * Usage:
 *   LIMIT=3 npx tsx scripts/correctMisclassifiedPhotoVideos.ts
 *   NOMINATION_IDS=uuid,uuid LIMIT=2 npx tsx scripts/correctMisclassifiedPhotoVideos.ts
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import OpenAI, { toFile, APIError } from "openai";
import { v2 as cloudinary } from "cloudinary";
import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { Nomination } from "../src/models/Nomination";
import {
  NominationVideo,
  PRODUCTION_AUDIO_FILENAME,
  PRODUCTION_VIDEO_BATCH_ID,
} from "../src/models/NominationVideo";
import { TeacherPortrait } from "../src/models/TeacherPortrait";
import { isEligibleStudentVideo } from "../src/lib/studentVideoEligibility";
import { hasSourcePhoto } from "../src/lib/sourcePhoto";
import { phone10 } from "../src/lib/resolveTeacherPortrait";
import {
  bgRemoveRoot,
  encodeTeacherVideo,
  materializeCroppedPortrait,
  newVideoRenderId,
  publishTeacherVideo,
  renderPaths,
} from "../src/lib/renderTeacherVideo";
import { pickRandomCategoryIcon, rasterizeCategoryIcon } from "../src/lib/categoryIcons";

const ANAS_ID = "0c8f2679-33cf-40db-96a9-723a6446fdae";
const MODEL = "gpt-image-2";
const LIMIT = Math.max(1, Number(process.env.LIMIT || 3));
const PHOTO_AREA_BOTTOM = 1372;
const requireFromHere = createRequire(__filename);

const PORTRAIT_PROMPT = [
  "IMAGE 1 is the identity source photograph of one specific real teacher. Recreate THIS exact person.",
  "Create a premium photorealistic professional studio portrait of the exact same individual.",
  "Preserve exactly: facial structure, face shape, forehead, jawline, cheeks, chin, nose, eyes, eyebrows, lips, ears, hairline, hairstyle, hair texture, skin tone, natural skin texture, facial asymmetry, moles/marks, age, expression, exact clothing, clothing colors, clothing pattern, jewelry, existing accessories.",
  "Do not create a lookalike. Do not redesign the face. Do not beautify. Do not make the person younger. Do not change skin tone, hairstyle, clothing, or jewelry. Do not add or remove accessories.",
  "The source may be a selfie, screenshot, or poorly framed photo. Do not paste a cutout selfie. Photograph the same person as a waist-up standing studio portrait with an 85mm full-frame look, large soft key light, subtle fill, realistic skin, hair, and fabric.",
  "Complete natural shoulders and upper torso consistent with the existing body and clothing. Do not invent a different outfit.",
  "Vertical 1088x1920 canvas. Teacher only on a fully transparent background. The silhouette must not touch the left, right, or bottom edges. Leave transparent margin. No white, gray, orange, black backdrop, room, wall, Instagram UI, halo, drop shadow, glow, text, or template graphics.",
].join(" ");

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const redact = (value: string) =>
  value.replace(/sk-[a-zA-Z0-9_\-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

const pythonBin = (root: string) => {
  const venv = path.join(root, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
};

const publicApiError = (err: unknown) => {
  if (err instanceof APIError) {
    return {
      http_status: err.status ?? null,
      openai_error: redact(err.message || ""),
      retryable: err.status === 429 || (err.status ?? 0) >= 500,
    };
  }
  const message = redact(err instanceof Error ? err.message : String(err));
  return {
    http_status: null,
    openai_error: message,
    retryable: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(message),
  };
};

const downloadPhoto = async (photoUrl: string, destBase: string) => {
  const res = await fetch(photoUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Failed to download nomination photo_url (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim();
  const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
  const dest = `${destBase}${ext}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return {
    dest,
    contentType: contentType || "image/jpeg",
    bytes: buf.length,
    hash: createHash("sha256").update(buf).digest("hex"),
  };
};

const runPy = (root: string, args: string[]) => {
  const py = spawnSync(pythonBin(root), args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (py.status !== 0) throw new Error(redact((py.stderr || py.stdout || "python failed").trim()));
  return py.stdout || "";
};

const applyVariant5 = (root: string, inputPng: string, outputPng: string) => {
  const out = runPy(root, [path.join(__dirname, "applyVariant5Portrait.py"), inputPng, outputPng]);
  return JSON.parse(out || "{}");
};

const applyCrop = (root: string, inputPng: string, outputPng: string) => {
  const out = runPy(root, [path.join(__dirname, "applyApprovedPortraitCrop.py"), inputPng, outputPng]);
  return JSON.parse(out || "{}") as { visible_bottom: number; sprite_height: number; y: number; x: number; size: number[] };
};

const uploadPng = async (filePath: string, publicId: string) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary is not configured");
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  const uploaded = await cloudinary.uploader.upload(filePath, {
    folder: "niat-awards/teacher-portraits",
    public_id: publicId,
    resource_type: "image",
    format: "png",
    overwrite: true,
    invalidate: true,
    unique_filename: false,
    use_filename: false,
  });
  if (!uploaded.secure_url) throw new Error("Cloudinary did not return a portrait URL");
  return String(uploaded.secure_url);
};

const generateImage = async (client: OpenAI, sourcePath: string, contentType: string, destRaw: string) => {
  const identity = await toFile(fs.createReadStream(sourcePath), path.basename(sourcePath), {
    type: contentType,
  });
  let lastErr = publicApiError(new Error("image generation failed"));
  for (let attempt = 0; attempt <= 2; attempt++) {
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
      if (!lastErr.retryable || attempt === 2) {
        throw new Error(lastErr.openai_error || "image generation failed");
      }
      await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
    }
  }
  throw new Error(lastErr.openai_error || "image generation failed");
};

type Nom = {
  _id: string;
  type?: string | null;
  status?: string | null;
  teacher_name?: string | null;
  phone?: string | null;
  photo_url?: string | null;
  student_name?: string | null;
  nominator_name?: string | null;
};

const main = async () => {
  const apiKey = String(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  const baseURL = String(
    process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.openai.com/v1"
  ).trim();
  if (!apiKey) throw new Error("Missing LLM_API_KEY / OPENAI_API_KEY");
  const pkgPath = path.join(path.dirname(requireFromHere.resolve("openai")), "package.json");
  const sdkVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
  const probe = new OpenAI({ apiKey: "sdk-probe-only" });
  if (typeof probe.images?.edit !== "function") {
    throw new Error(`SDK incompatibility: openai ${sdkVersion} has no images.edit`);
  }

  await connectDB();
  const root = bgRemoveRoot();
  const nominations = (await Nomination.find({ type: "student", status: { $ne: "draft" } })
    .select("_id type status teacher_name phone photo_url student_name nominator_name")
    .sort({ _id: 1 })
    .lean()) as Nom[];
  const portraits = await TeacherPortrait.find({}).select("teacher_phone portrait_status").lean();
  const portraitPhones = new Set(portraits.map((p) => phone10(p.teacher_phone)));
  const videos = await NominationVideo.find({
    nomination_id: { $in: nominations.map((n) => n._id) },
  }).lean();
  const videoById = new Map(videos.map((v) => [v.nomination_id, v]));

  const incorrect = nominations.filter((nom) => {
    if (!isEligibleStudentVideo(nom) || !hasSourcePhoto(nom.photo_url)) return false;
    const video = videoById.get(nom._id);
    return video?.video_category === "without_photo" || video?.photo_used === false;
  });

  const forced = String(process.env.NOMINATION_IDS || ANAS_ID)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const selected: Nom[] = [];
  const seen = new Set<string>();
  const usedPhones = new Set<string>();
  const add = (nom: Nom | undefined) => {
    if (!nom || seen.has(nom._id)) return;
    const phone = phone10(nom.phone);
    if (phone && usedPhones.has(phone)) return;
    selected.push(nom);
    seen.add(nom._id);
    if (phone) usedPhones.add(phone);
  };
  for (const id of forced) add(incorrect.find((n) => n._id === id) || nominations.find((n) => n._id === id));
  const noPortraitFirst = incorrect.filter((n) => !portraitPhones.has(phone10(n.phone)));
  for (const nom of noPortraitFirst) {
    if (selected.length >= LIMIT) break;
    add(nom);
  }
  for (const nom of incorrect) {
    if (selected.length >= LIMIT) break;
    add(nom);
  }

  log(`Incorrect with-source-photo videos: ${incorrect.length}`);
  log(`Verification batch: ${selected.length}`);
  for (const nom of selected) {
    log(`  ${nom._id} ${nom.teacher_name} photo=${Boolean(nom.photo_url)}`);
  }

  const client = new OpenAI({ apiKey, baseURL, timeout: 240000, maxRetries: 0 });
  const results: Record<string, unknown>[] = [];

  for (const nom of selected) {
    const teacherName = String(nom.teacher_name || "").trim();
    const photoUrl = String(nom.photo_url || "").trim();
    const phone = phone10(nom.phone);
    log(`START ${nom._id} ${teacherName}`);
    try {
      if (!hasSourcePhoto(photoUrl)) throw new Error("nomination has no valid source photo_url");
      if (!teacherName) throw new Error("missing teacher_name");
      if (phone.length !== 10) throw new Error("teacher phone is not 10 digits");

      const workDir = path.join(root, "work", "portraits", nom._id);
      fs.mkdirSync(workDir, { recursive: true });
      const source = await downloadPhoto(photoUrl, path.join(workDir, "source"));
      log(`  source hash=${source.hash.slice(0, 12)} bytes=${source.bytes}`);

      await TeacherPortrait.findOneAndUpdate(
        { teacher_phone: phone },
        {
          $set: {
            teacher_name: teacherName,
            source_nomination_id: nom._id,
            source_photo_url: photoUrl,
            source_photo_hash: source.hash,
            portrait_status: "PROCESSING",
            portrait_error: null,
          },
          $setOnInsert: { teacher_phone: phone },
        },
        { upsert: true }
      );

      const rawPng = path.join(workDir, "gpt-raw.png");
      const variantPng = path.join(workDir, "variant5.png");
      const croppedPng = path.join(root, "output", "teacher-portraits", "cropped", `${phone}.png`);
      await generateImage(client, source.dest, source.contentType, rawPng);
      log("  openai portrait generated");
      applyVariant5(root, rawPng, variantPng);
      const geom = applyCrop(root, variantPng, croppedPng);
      if (geom.visible_bottom !== PHOTO_AREA_BOTTOM) {
        throw new Error(`crop bottom ${geom.visible_bottom} != ${PHOTO_AREA_BOTTOM}`);
      }
      log(`  cropped Y=${PHOTO_AREA_BOTTOM} sprite=${geom.sprite_width || "?"}x${geom.sprite_height}`);

      const croppedUrl = await uploadPng(croppedPng, phone);
      log("  cropped portrait uploaded");
      await TeacherPortrait.findOneAndUpdate(
        { teacher_phone: phone },
        {
          $set: {
            teacher_name: teacherName,
            source_nomination_id: nom._id,
            source_photo_url: photoUrl,
            source_photo_hash: source.hash,
            portrait_cloudinary_url: croppedUrl,
            cropped_cloudinary_url: croppedUrl,
            cropped_local_png_path: croppedPng,
            local_png_path: variantPng,
            portrait_status: "GENERATED",
            portrait_error: null,
          },
        }
      );

      const renderId = newVideoRenderId();
      const paths = renderPaths(root, nom._id, renderId);
      fs.mkdirSync(paths.renderDir, { recursive: true });
      const icon = pickRandomCategoryIcon(root);
      const iconPng = path.join(paths.renderDir, "category-icon.png");
      rasterizeCategoryIcon(icon.svgPath, iconPng);
      const prepared = await materializeCroppedPortrait({
        dest: paths.preparedPath,
        localPath: croppedPng,
        cloudinaryUrl: croppedUrl,
      });
      const encoded = await encodeTeacherVideo({
        nominationId: nom._id,
        teacherName,
        nominatorName: String(nom.student_name || nom.nominator_name || "").trim(),
        renderId,
        preparedPortraitPath: prepared,
        categoryIconPath: iconPng,
        categoryIconId: icon.category_icon_id,
        categoryIconFilename: icon.category_icon_filename,
      });
      if (!encoded.payload.ok || !encoded.payload.photo_used) {
        throw new Error("with-photo render did not use the portrait or failed validation");
      }
      const placement = (encoded.payload.placement || null) as Record<string, unknown> | null;
      const sh = Number(placement?.sprite_height);
      const py = Number(placement?.paste_y);
      if (py + sh !== PHOTO_AREA_BOTTOM) {
        throw new Error(`placement assert failed paste_y+height=${py}+${sh}`);
      }
      const validation = (encoded.payload.validation || {}) as Record<string, unknown>;
      const generated = (validation.generated || {}) as Record<string, unknown>;
      if (!generated.has_audio) throw new Error("rendered MP4 is missing audio");

      const published = await publishTeacherVideo(encoded, nom._id);
      await NominationVideo.findOneAndUpdate(
        { nomination_id: nom._id },
        {
          $set: {
            nomination_id: nom._id,
            generation_status: "generated",
            review_status: "ready_for_review",
            video_url: published.videoUrl,
            video_render_id: renderId,
            generated_at: new Date(),
            ready_for_message: false,
            generation_error: null,
            portrait_cloudinary_url: croppedUrl,
            photo_used: true,
            video_category: "with_photo",
            category_icon_id: icon.category_icon_id,
            category_icon_filename: icon.category_icon_filename,
            audio_filename: PRODUCTION_AUDIO_FILENAME,
            production_batch_id: PRODUCTION_VIDEO_BATCH_ID,
          },
        },
        { upsert: true, new: true }
      );
      log(`  ok video ${published.videoUrl}`);
      results.push({
        nomination_id: nom._id,
        teacher_name: teacherName,
        source_photo_url: photoUrl,
        source_photo_hash: source.hash,
        portrait_cloudinary_url: croppedUrl,
        video_url: published.videoUrl,
        render_id: renderId,
        photo_used: true,
        video_category: "with_photo",
        ready_for_message: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`  FAILED ${message.slice(0, 400)}`);
      await TeacherPortrait.findOneAndUpdate(
        { teacher_phone: phone },
        { $set: { portrait_status: "FAILED", portrait_error: message.slice(0, 2000) } }
      ).catch(() => undefined);
      await NominationVideo.findOneAndUpdate(
        { nomination_id: nom._id },
        {
          $set: {
            nomination_id: nom._id,
            generation_status: "failed",
            generation_error: message.slice(0, 2000),
            video_category: "with_photo",
            photo_used: false,
            ready_for_message: false,
          },
        },
        { upsert: true }
      ).catch(() => undefined);
      results.push({ nomination_id: nom._id, teacher_name: teacherName, error: message });
    }
  }

  const reportPath = path.join(root, "output", "videos", "classification-correction-verify.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        incorrect_total: incorrect.length,
        attempted: selected.length,
        success: results.filter((r) => !r.error).length,
        failed: results.filter((r) => r.error).length,
        results,
      },
      null,
      2
    )
  );
  log(`DONE report=${reportPath}`);
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
