/**
 * Bulk: apply the approved Anas Khan top-60% crop to every WITH-PHOTO student video.
 * Does not call OpenAI. Does not touch no-photo videos.
 *
 * Usage: npx tsx scripts/regenerateWithPhotoVideosTop60Crop.ts
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
import { namesCompatible, phone10 } from "../src/lib/resolveTeacherPortrait";
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
const CONCURRENCY = 2;
const APPROVED_TEST_ID = "0c8f2679-33cf-40db-96a9-723a6446fdae";

type Geom = {
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

type Portrait = {
  teacher_phone?: string | null;
  teacher_name?: string | null;
  source_nomination_id?: string | null;
  source_photo_url?: string | null;
  local_png_path?: string | null;
  portrait_status?: string | null;
};

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const pythonBin = (root: string) => {
  const venv = path.join(root, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
};

const applyTop60Crop = (root: string, inputPng: string, outputPng: string): Geom => {
  const py = spawnSync(
    pythonBin(root),
    [path.join(__dirname, "applyApprovedPortraitCrop.py"), inputPng, outputPng],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (py.status !== 0) throw new Error((py.stderr || py.stdout || "crop failed").trim());
  return JSON.parse(py.stdout || "{}") as Geom;
};

const findGeneratedPortrait = (root: string, phone: string, localPath?: string | null) => {
  const outDir = path.join(root, "output", "teacher-portraits");
  const candidates = [
    String(localPath || "").trim(),
    path.join(outDir, "by-phone", `${phone}.png`),
    path.join(outDir, `${phone}.png`),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || "";
};

const portraitBelongsToNomination = (nom: Nom, portrait: Portrait | null) => {
  if (!portrait) return { ok: false, reason: "no_teacher_portrait" };
  const phone = phone10(nom.phone);
  const portraitPhone = phone10(portrait.teacher_phone);
  if (phone.length !== 10 || phone !== portraitPhone) return { ok: false, reason: "phone_mismatch" };
  if (!namesCompatible(nom.teacher_name, portrait.teacher_name)) {
    return { ok: false, reason: "teacher_name_conflict_on_same_phone" };
  }
  const nomPhoto = String(nom.photo_url || "").trim();
  const sourcePhoto = String(portrait.source_photo_url || "").trim();
  const isSourceNom = String(portrait.source_nomination_id || "") === nom._id;
  if (!isSourceNom && sourcePhoto && nomPhoto && sourcePhoto !== nomPhoto) {
    return { ok: false, reason: "portrait_source_is_another_nomination_photo" };
  }
  if (!isSourceNom && sourcePhoto && nomPhoto && sourcePhoto === nomPhoto) {
    return { ok: true, reason: "same_source_photo" };
  }
  if (!isSourceNom && sourcePhoto && !nomPhoto) {
    return { ok: false, reason: "no_source_photo" };
  }
  if (!isSourceNom && !sourcePhoto) {
    return { ok: false, reason: "portrait_source_nomination_unknown" };
  }
  if (String(portrait.portrait_status || "") !== "GENERATED") {
    return { ok: false, reason: "portrait_not_generated" };
  }
  return { ok: true, reason: isSourceNom ? "source_nomination" : "ok" };
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
  const nominations = (await Nomination.find({ type: "student", status: { $ne: "draft" } })
    .select("_id type status teacher_name phone photo_url student_name nominator_name")
    .sort({ _id: 1 })
    .lean()) as Nom[];
  const portraits = (await TeacherPortrait.find({}).lean()) as Portrait[];
  const videos = await NominationVideo.find({
    nomination_id: { $in: nominations.map((n) => n._id) },
  }).lean();
  const byPhone = new Map(portraits.map((p) => [phone10(p.teacher_phone), p]));
  const videoById = new Map(videos.map((v) => [v.nomination_id, v]));

  const noPhotoProtected = nominations.filter(
    (n) => isEligibleStudentVideo(n) && !hasSourcePhoto(n.photo_url)
  );
  const noPhotoUrlsBefore = new Map(
    noPhotoProtected.map((n) => [n._id, String(videoById.get(n._id)?.video_url || "")])
  );

  const skipped: Record<string, unknown>[] = [];
  const planned: Nom[] = [];
  for (const nom of nominations) {
    if (!isEligibleStudentVideo(nom)) continue;
    if (!hasSourcePhoto(nom.photo_url)) {
      skipped.push({ nomination_id: nom._id, teacher_name: nom.teacher_name, reason: "no_source_photo" });
      continue;
    }
    const video = videoById.get(nom._id);
    if (video?.video_category === "without_photo") {
      skipped.push({
        nomination_id: nom._id,
        teacher_name: nom.teacher_name,
        reason: "existing_without_photo_video_protected",
      });
      continue;
    }
    if (
      nom._id === APPROVED_TEST_ID &&
      video?.photo_used &&
      String(video.portrait_cloudinary_url || "").includes("-top60")
    ) {
      skipped.push({
        nomination_id: nom._id,
        teacher_name: nom.teacher_name,
        reason: "approved_anas_khan_test",
      });
      continue;
    }
    const portrait = byPhone.get(phone10(nom.phone)) || null;
    const belong = portraitBelongsToNomination(nom, portrait);
    if (!belong.ok) {
      skipped.push({
        nomination_id: nom._id,
        teacher_name: nom.teacher_name,
        reason: belong.reason,
        stage: "mapping",
      });
      continue;
    }
    const sourcePng = findGeneratedPortrait(root, phone10(nom.phone), portrait?.local_png_path);
    if (!sourcePng) {
      skipped.push({
        nomination_id: nom._id,
        teacher_name: nom.teacher_name,
        reason: "missing_openai_generated_png",
        stage: "source_portrait",
      });
      continue;
    }
    planned.push(nom);
  }

  log(`Eligible student nominations: ${nominations.filter(isEligibleStudentVideo).length}`);
  log(`No-photo protected: ${noPhotoProtected.length}`);
  log(`WITH-PHOTO to regenerate: ${planned.length}`);
  log(`Skipped: ${skipped.length}`);

  const cropCache = new Map<string, Promise<{ destPng: string; url: string; geom: Geom }>>();
  const successes: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  let cursor = 0;
  let portraitsUploaded = 0;
  let videosUploaded = 0;
  let dbUpdated = 0;

  const reportPath = path.join(root, "output", "videos", "with-photo-top60-bulk-report.json");
  const writeReport = () => {
    const noPhotoUrlsAfterTouched = [...noPhotoUrlsBefore.entries()].filter(([id, before]) => {
      return false;
    });
    void noPhotoUrlsAfterTouched;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          production_batch_id: PRODUCTION_VIDEO_BATCH_ID,
          crop: "top_60_percent",
          eligible_with_photo: planned.length + skipped.filter((s) => s.reason === "approved_anas_khan_test").length,
          attempted: planned.length,
          successful: successes.length,
          failed: failures.length,
          skipped: skipped.length,
          no_photo_protected: noPhotoProtected.length,
          portraits_uploaded: portraitsUploaded,
          videos_uploaded: videosUploaded,
          db_records_updated: dbUpdated,
          failures,
          skipped_rows: skipped,
          videos: successes,
        },
        null,
        2
      )
    );
  };

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= planned.length) return;
      const nom = planned[index];
      const n = index + 1;
      const phone = phone10(nom.phone);
      const portrait = byPhone.get(phone) || null;
      log(`[${String(n).padStart(4, "0")}/${planned.length}] ${nom.teacher_name} ${nom._id}`);
      try {
        if (!hasSourcePhoto(nom.photo_url)) throw new Error("source photo disappeared");
        const teacherName = String(nom.teacher_name || "").trim();
        if (!teacherName) throw new Error("missing teacher_name");
        const sourcePng = findGeneratedPortrait(root, phone, portrait?.local_png_path);
        if (!sourcePng) throw new Error("missing existing OpenAI-generated portrait");
        const destPng = path.join(root, "output", "teacher-portraits", "cropped-top60", `${phone}.png`);
        let pending = cropCache.get(sourcePng);
        if (!pending) {
          pending = (async () => {
            const geom = applyTop60Crop(root, sourcePng, destPng);
            if (geom.keep_top_ratio !== 0.6) throw new Error("crop did not keep top 60%");
            if (geom.canvas_keep_height !== 1152 || geom.canvas_removed_bottom_px !== 768) {
              throw new Error("crop did not remove bottom 40% of 1920 canvas");
            }
            if (geom.visible_bottom !== PHOTO_AREA_BOTTOM) throw new Error(`visible bottom ${geom.visible_bottom}`);
            if (geom.y + geom.sprite_height !== PHOTO_AREA_BOTTOM) {
              throw new Error(`paste_y+height ${geom.y}+${geom.sprite_height}`);
            }
            if (geom.size[0] !== 1080 || geom.size[1] !== 1920 || geom.mode !== "RGBA") {
              throw new Error("prepared canvas is not 1080x1920 RGBA");
            }
            if (!geom.pixels_unchanged) throw new Error("teacher pixels changed");
            const url = await uploadCropped(destPng, phone);
            portraitsUploaded += 1;
            await TeacherPortrait.findOneAndUpdate(
              { teacher_phone: phone },
              {
                $set: {
                  cropped_cloudinary_url: url,
                  cropped_local_png_path: destPng,
                  portrait_cloudinary_url: url,
                  portrait_error: null,
                },
              }
            );
            return { destPng, url, geom };
          })();
          pending.catch(() => {
            if (cropCache.get(sourcePng) === pending) cropCache.delete(sourcePng);
          });
          cropCache.set(sourcePng, pending);
        }
        const cached = await pending;

        const prev = videoById.get(nom._id);
        const renderId = newVideoRenderId();
        const paths = renderPaths(root, nom._id, renderId);
        fs.mkdirSync(paths.renderDir, { recursive: true });
        const icon = resolveIcon(root, prev?.category_icon_filename, prev?.category_icon_id);
        const iconPng = path.join(paths.renderDir, "category-icon.png");
        rasterizeCategoryIcon(icon.svgPath, iconPng);
        const prepared = await materializeCroppedPortrait({
          dest: paths.preparedPath,
          localPath: cached.destPng,
          cloudinaryUrl: cached.url,
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
          throw new Error("with-photo render did not use the cropped portrait");
        }
        const placement = (encoded.payload.placement || {}) as Record<string, unknown>;
        const pasteY = Number(placement.paste_y);
        const spriteH = Number(placement.sprite_height);
        if (pasteY + spriteH !== PHOTO_AREA_BOTTOM) throw new Error(`renderer bottom ${pasteY}+${spriteH}`);
        if (placement.second_translation === true) throw new Error("renderer applied a second translation");
        if (JSON.stringify(placement.composite) !== JSON.stringify([0, 0]) && placement.prepared_canvas !== true) {
          throw new Error("renderer did not composite prepared canvas at 0,0");
        }
        const generated = ((encoded.payload.validation || {}) as Record<string, unknown>).generated as
          | Record<string, unknown>
          | undefined;
        if (!generated?.has_audio) throw new Error("rendered MP4 is missing audio");

        const published = await publishTeacherVideo(encoded, nom._id);
        videosUploaded += 1;
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
              portrait_cloudinary_url: cached.url,
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
        dbUpdated += 1;
        successes.push({
          nomination_id: nom._id,
          teacher_name: teacherName,
          photo_used: true,
          crop: "top_60_percent",
          cropped_dimensions: `${cached.geom.sprite_width}x${cached.geom.sprite_height}`,
          paste_x: cached.geom.x,
          paste_y: cached.geom.y,
          visible_bottom: cached.geom.visible_bottom,
          category_icon: icon.category_icon_filename,
          render_id: renderId,
          portrait_cloudinary_url: cached.url,
          video_cloudinary_url: published.videoUrl,
          audio_attached: true,
        });
        log(`  ok render_id=${renderId} sprite=${cached.geom.sprite_width}x${cached.geom.sprite_height} y=${cached.geom.y}`);
        if (successes.length % 25 === 0) writeReport();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({
          nomination_id: nom._id,
          teacher_name: nom.teacher_name,
          stage: "crop_or_render",
          error: message.slice(0, 500),
        });
        log(`  FAILED ${message.slice(0, 300)}`);
        await NominationVideo.findOneAndUpdate(
          { nomination_id: nom._id, video_category: { $ne: "without_photo" } },
          {
            $set: {
              generation_status: "failed",
              generation_error: message.slice(0, 2000),
              ready_for_message: false,
              video_category: "with_photo",
            },
          }
        ).catch(() => undefined);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const afterVideos = await NominationVideo.find({
    nomination_id: { $in: [...noPhotoUrlsBefore.keys()] },
  })
    .select("nomination_id video_url video_category photo_used")
    .lean();
  const noPhotoModified = afterVideos.filter((v) => {
    const before = noPhotoUrlsBefore.get(v.nomination_id) || "";
    return String(v.video_url || "") !== before;
  });

  writeReport();
  const final = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
  final.no_photo_videos_modified = noPhotoModified.length;
  final.admin_with_photo_successes = successes.length + skipped.filter((s) => s.reason === "approved_anas_khan_test").length;
  fs.writeFileSync(reportPath, JSON.stringify(final, null, 2));

  log(`DONE success=${successes.length} failed=${failures.length} skipped=${skipped.length} no_photo_protected=${noPhotoProtected.length} no_photo_modified=${noPhotoModified.length}`);
  log(`Report: ${reportPath}`);
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
