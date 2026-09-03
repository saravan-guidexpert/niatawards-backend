/**
 * ONE with-photo test: crop existing OpenAI portrait (keep top 60%, drop bottom 40%),
 * bottom-anchor at Y=1372, render a new MP4. Does not call OpenAI. Does not touch no-photo videos.
 *
 * Usage: npx tsx scripts/regenerateOnePhotoVideoTop60Crop.ts
 * Optional: NOMINATION_ID=<uuid>
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

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
import {
  categoryIconDir,
  pickRandomCategoryIcon,
  rasterizeCategoryIcon,
} from "../src/lib/categoryIcons";

const PHOTO_AREA_BOTTOM = 1372;
const DEFAULT_ID = "0c8f2679-33cf-40db-96a9-723a6446fdae";

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const pythonBin = (root: string) => {
  const venv = path.join(root, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
};

const applyTop60Crop = (root: string, inputPng: string, outputPng: string) => {
  const py = spawnSync(
    pythonBin(root),
    [path.join(__dirname, "applyApprovedPortraitCrop.py"), inputPng, outputPng],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (py.status !== 0) {
    throw new Error((py.stderr || py.stdout || "crop failed").trim());
  }
  return JSON.parse(py.stdout || "{}") as {
    keep_top_ratio: number;
    canvas_keep_height: number;
    canvas_removed_bottom_px: number;
    x: number;
    y: number;
    sprite_width: number;
    sprite_height: number;
    visible_bottom: number;
    size: number[];
    mode: string;
    pixels_unchanged: boolean;
    second_translation: boolean;
  };
};

const resolveGeneratedPortrait = (root: string, phone: string, localPath?: string | null) => {
  const outDir = path.join(root, "output", "teacher-portraits");
  const candidates = [
    String(localPath || "").trim(),
    path.join(outDir, "by-phone", `${phone}.png`),
    path.join(outDir, `${phone}.png`),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`missing existing OpenAI-generated portrait for ${phone}`);
};

const resolveIcon = (root: string, filename?: string | null, id?: string | null) => {
  if (filename) {
    const svgPath = path.join(categoryIconDir(root), filename);
    if (fs.existsSync(svgPath)) {
      return {
        category_icon_id: String(id || filename.replace(/\.svg$/i, "")),
        category_icon_filename: filename,
        svgPath,
      };
    }
  }
  return pickRandomCategoryIcon(root);
};

const uploadCropped = async (filePath: string, phone: string) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary is not configured");
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  const uploaded = await cloudinary.uploader.upload(filePath, {
    folder: "niat-awards/teacher-portraits",
    public_id: `${phone}-top60`,
    resource_type: "image",
    format: "png",
    overwrite: true,
    invalidate: true,
    unique_filename: false,
    use_filename: false,
  });
  if (!uploaded.secure_url) throw new Error("Cloudinary did not return a cropped portrait URL");
  return String(uploaded.secure_url);
};

const main = async () => {
  await connectDB();
  const root = bgRemoveRoot();
  const wanted = String(process.env.NOMINATION_ID || DEFAULT_ID).trim();
  const nomination = await Nomination.findById(wanted);
  if (!nomination || !isEligibleStudentVideo(nomination)) {
    throw new Error("nomination is not an eligible student record");
  }
  if (!hasSourcePhoto(nomination.photo_url)) {
    throw new Error("test nomination has no source photo — refusing to use no-photo pipeline");
  }
  const video = await NominationVideo.findOne({ nomination_id: nomination._id }).lean();
  if (video?.video_category === "without_photo" && !hasSourcePhoto(nomination.photo_url)) {
    throw new Error("refusing to touch a genuine no-photo video");
  }
  const phone = phone10(nomination.phone);
  const portrait = await TeacherPortrait.findOne({ teacher_phone: phone }).lean();
  if (!portrait) throw new Error("TeacherPortrait not found");
  const sourcePng = resolveGeneratedPortrait(root, phone, portrait.local_png_path);
  const destPng = path.join(root, "output", "teacher-portraits", "cropped-top60", `${phone}.png`);

  log(`nomination=${nomination._id} teacher=${nomination.teacher_name}`);
  log(`source OpenAI portrait: ${sourcePng}`);
  const geom = applyTop60Crop(root, sourcePng, destPng);
  if (geom.keep_top_ratio !== 0.6) throw new Error("crop did not keep top 60%");
  if (geom.canvas_removed_bottom_px !== 768) throw new Error("crop did not remove bottom 40% of 1920 canvas");
  if (geom.visible_bottom !== PHOTO_AREA_BOTTOM) throw new Error(`visible bottom ${geom.visible_bottom}`);
  if (geom.y + geom.sprite_height !== PHOTO_AREA_BOTTOM) {
    throw new Error(`paste_y+height ${geom.y}+${geom.sprite_height}`);
  }
  if (geom.size[0] !== 1080 || geom.size[1] !== 1920 || geom.mode !== "RGBA") {
    throw new Error("prepared canvas is not 1080x1920 RGBA");
  }
  log(`crop keep_h=${geom.canvas_keep_height} removed_bottom=${geom.canvas_removed_bottom_px} sprite=${geom.sprite_width}x${geom.sprite_height} paste=${geom.x},${geom.y} bottom=${geom.visible_bottom}`);

  const croppedUrl = await uploadCropped(destPng, phone);
  log(`cropped Cloudinary: ${croppedUrl}`);
  await TeacherPortrait.findOneAndUpdate(
    { teacher_phone: phone },
    {
      $set: {
        cropped_cloudinary_url: croppedUrl,
        cropped_local_png_path: destPng,
        portrait_cloudinary_url: croppedUrl,
        portrait_error: null,
      },
    }
  );

  const teacherName = String(nomination.teacher_name || "").trim();
  const renderId = newVideoRenderId();
  const paths = renderPaths(root, String(nomination._id), renderId);
  fs.mkdirSync(paths.renderDir, { recursive: true });
  const icon = resolveIcon(root, video?.category_icon_filename, video?.category_icon_id);
  const iconPng = path.join(paths.renderDir, "category-icon.png");
  rasterizeCategoryIcon(icon.svgPath, iconPng);
  const prepared = await materializeCroppedPortrait({
    dest: paths.preparedPath,
    localPath: destPng,
    cloudinaryUrl: croppedUrl,
  });
  const encoded = await encodeTeacherVideo({
    nominationId: String(nomination._id),
    teacherName,
    nominatorName: String(nomination.student_name || nomination.nominator_name || "").trim(),
    renderId,
    preparedPortraitPath: prepared,
    categoryIconPath: iconPng,
    categoryIconId: icon.category_icon_id,
    categoryIconFilename: icon.category_icon_filename,
  });
  if (!encoded.payload.ok || !encoded.payload.photo_used) {
    throw new Error("with-photo render did not use the cropped portrait");
  }
  const placement = (encoded.payload.placement || {}) as Record<string, unknown>;
  const py = Number(placement.paste_y);
  const sh = Number(placement.sprite_height);
  if (py + sh !== PHOTO_AREA_BOTTOM) throw new Error(`renderer bottom ${py}+${sh}`);
  if (placement.second_translation === true) throw new Error("renderer applied a second translation");
  const generated = ((encoded.payload.validation || {}) as Record<string, unknown>).generated as
    | Record<string, unknown>
    | undefined;
  if (!generated?.has_audio) throw new Error("rendered MP4 is missing audio");

  const published = await publishTeacherVideo(encoded, String(nomination._id));
  await NominationVideo.findOneAndUpdate(
    { nomination_id: nomination._id },
    {
      $set: {
        nomination_id: String(nomination._id),
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
    { upsert: true }
  );

  const report = {
    nomination_id: nomination._id,
    teacher_name: teacherName,
    source_portrait: sourcePng,
    cropped_local_png_path: destPng,
    cropped_cloudinary_url: croppedUrl,
    geometry: geom,
    placement,
    render_id: renderId,
    video_url: published.videoUrl,
    photo_used: true,
    video_category: "with_photo",
    ready_for_message: false,
    preview: path.join(root, "output", "teacher-portraits", `${nomination._id}-preview.png`),
  };
  const reportPath = path.join(root, "output", "videos", "top60-crop-one-test.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`NEW video ${published.videoUrl}`);
  log(`preview ${report.preview}`);
  log(`STOP after one test. Report: ${reportPath}`);
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
