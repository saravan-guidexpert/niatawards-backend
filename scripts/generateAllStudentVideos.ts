/**
 * FINAL production bulk: one Teacher’s Day video per eligible student nomination.
 * Muxes nominated-by-students.mp3 onto every MP4. No messages.
 * Consumes finalized TeacherPortrait cropped URLs only — never calls OpenAI or crop.
 *
 * Usage: npx tsx scripts/generateAllStudentVideos.ts
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import util from "util";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

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
import { isFinalizedPortrait } from "../src/lib/nominationKind";
import { phone10, resolveTeacherPortrait } from "../src/lib/resolveTeacherPortrait";
import {
  bgRemoveRoot,
  encodeTeacherVideo,
  materializeCroppedPortrait,
  newVideoRenderId,
  publishTeacherVideo,
  renderPaths,
  soundtrackPath,
} from "../src/lib/renderTeacherVideo";
import { pickRandomCategoryIcon, rasterizeCategoryIcon } from "../src/lib/categoryIcons";

const CONCURRENCY = 2;

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

type Planned = {
  nomination: Nom;
  phone: string;
  category: "with_photo" | "without_photo";
  croppedUrl: string;
  croppedLocal: string;
};

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const errMessage = (err: unknown) => {
  if (err instanceof Error && err.message && err.message !== "[object Object]") return err.message;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const record = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof record.message === "string" && record.message.trim() && record.message !== "[object Object]") {
      return record.message;
    }
    if (typeof record.error?.message === "string") return record.error.message;
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}" && json !== "null") return json;
    } catch {
      /* ignore */
    }
  }
  return util.inspect(err, { depth: 4 });
};

const hasPlayableUrl = (url: unknown) => /^https?:\/\//i.test(String(url || "").trim());

const audioOk = (payload: Record<string, unknown>) => {
  const validation = (payload.validation || {}) as Record<string, unknown>;
  const generated = (validation.generated || {}) as Record<string, unknown>;
  return Boolean(payload.ok) && Boolean(generated.has_audio || validation.ok);
};

const main = async () => {
  await connectDB();
  const root = bgRemoveRoot();
  const audio = soundtrackPath(root);
  if (!fs.existsSync(audio)) {
    throw new Error(`soundtrack missing: ${audio}`);
  }
  const template = path.join(root, "assets", "teacher-student", "template", "template.mp4");
  if (!fs.existsSync(template)) throw new Error(`missing template: ${template}`);
  const nophotoPlate = path.join(root, "assets", "teacher-student", "frames", "02-nophoto.png");
  if (!fs.existsSync(nophotoPlate)) throw new Error(`missing no-photo Frame 2: ${nophotoPlate}`);

  const nominations = (await Nomination.find({ type: "student", status: { $ne: "draft" } })
    .select("_id type status teacher_name phone photo_url student_name nominator_name")
    .sort({ _id: 1 })
    .lean()) as Nom[];
  const portraits = await TeacherPortrait.find({})
    .select(
      "teacher_phone teacher_name source_nomination_id source_photo_url portrait_cloudinary_url cropped_cloudinary_url cropped_local_png_path portrait_status"
    )
    .lean();
  const byPhone = new Map(portraits.map((p) => [phone10(p.teacher_phone), p]));
  const existing = await NominationVideo.find({
    nomination_id: { $in: nominations.map((n) => n._id) },
  }).lean();
  const existingById = new Map(existing.map((v) => [v.nomination_id, v]));

  const planned: Planned[] = [];
  const skipped: string[] = [];
  const skippedNeedsPortrait: string[] = [];
  for (const nom of nominations) {
    if (!isEligibleStudentVideo(nom)) continue;
    const prev = existingById.get(nom._id);
    if (
      prev &&
      prev.production_batch_id === PRODUCTION_VIDEO_BATCH_ID &&
      prev.generation_status === "generated" &&
      hasPlayableUrl(prev.video_url)
    ) {
      skipped.push(nom._id);
      continue;
    }
    const phone = phone10(nom.phone);
    const hasPhoto = hasSourcePhoto(nom.photo_url);
    const portrait = byPhone.get(phone) || null;
    const resolved = resolveTeacherPortrait({ ...nom, id: nom._id }, portrait);
    const usablePortrait =
      hasPhoto &&
      isFinalizedPortrait(portrait) &&
      resolved.mapping === "MATCH" &&
      resolved.usable &&
      Boolean(resolved.portrait_cloudinary_url);
    if (hasPhoto && !usablePortrait) {
      skippedNeedsPortrait.push(nom._id);
      continue;
    }
    planned.push({
      nomination: nom,
      phone,
      category: hasPhoto ? "with_photo" : "without_photo",
      croppedUrl: usablePortrait ? String(resolved.portrait_cloudinary_url) : "",
      croppedLocal: usablePortrait ? String(resolved.cropped_local_png_path || "") : "",
    });
  }

  if (process.env.SMOKE === "1") {
    const photo = planned.find((p) => p.category === "with_photo");
    const nophoto = planned.find((p) => p.category === "without_photo");
    planned.splice(0, planned.length);
    if (nophoto) planned.push(nophoto);
    if (photo) planned.push(photo);
    log("SMOKE mode: one with_photo and one without_photo");
  }

  log(`Eligible nominations: ${nominations.filter(isEligibleStudentVideo).length}`);
  log(`Already completed in ${PRODUCTION_VIDEO_BATCH_ID}: ${skipped.length}`);
  log(`Skipped (source photo, portrait not ready): ${skippedNeedsPortrait.length}`);
  log(`To render: ${planned.length} (with_photo=${planned.filter((p) => p.category === "with_photo").length} without_photo=${planned.filter((p) => p.category === "without_photo").length})`);
  log(`Soundtrack: ${audio}`);

  const successes: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= planned.length) return;
      const candidate = planned[index];
      const nom = candidate.nomination;
      const n = index + 1;
      log(`[${String(n).padStart(4, "0")}/${planned.length}] ${candidate.category} ${nom.teacher_name} ${nom._id}`);
      try {
        const teacherName = String(nom.teacher_name || "").trim();
        if (!teacherName) throw new Error("missing teacher_name");
        const studentName = String(nom.student_name || nom.nominator_name || "").trim();
        const renderId = newVideoRenderId();
        const paths = renderPaths(root, nom._id, renderId);
        fs.mkdirSync(paths.renderDir, { recursive: true });
        const icon = pickRandomCategoryIcon(root);
        const iconPng = path.join(paths.renderDir, "category-icon.png");
        rasterizeCategoryIcon(icon.svgPath, iconPng);

        let preparedPath = "";
        if (candidate.category === "with_photo") {
          preparedPath = await materializeCroppedPortrait({
            dest: paths.preparedPath,
            localPath: candidate.croppedLocal,
            cloudinaryUrl: candidate.croppedUrl,
          });
        }

        const encoded = await encodeTeacherVideo({
          nominationId: nom._id,
          teacherName,
          nominatorName: studentName,
          renderId,
          preparedPortraitPath: preparedPath || null,
          categoryIconPath: iconPng,
          categoryIconId: icon.category_icon_id,
          categoryIconFilename: icon.category_icon_filename,
        });
        if (!audioOk(encoded.payload)) {
          throw new Error("rendered MP4 is missing a valid audio stream");
        }
        const photoUsed = Boolean(encoded.payload.photo_used);
        if (candidate.category === "with_photo") {
          if (!photoUsed) throw new Error("with-photo render did not use a portrait");
          const placement = (encoded.payload.placement || null) as Record<string, unknown> | null;
          const sh = Number(placement?.sprite_height);
          const py = Number(placement?.paste_y);
          if (py + sh !== 1372) {
            throw new Error(`placement assert failed paste_y+height=${py}+${sh}`);
          }
        } else if (photoUsed) {
          throw new Error("no-photo render inserted a portrait");
        }

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
              portrait_cloudinary_url: candidate.category === "with_photo" ? candidate.croppedUrl : null,
              photo_used: photoUsed,
              video_category: candidate.category,
              category_icon_id: icon.category_icon_id,
              category_icon_filename: icon.category_icon_filename,
              audio_filename: PRODUCTION_AUDIO_FILENAME,
              production_batch_id: PRODUCTION_VIDEO_BATCH_ID,
            },
          },
          { upsert: true, new: true }
        );

        const row = {
          nomination_id: nom._id,
          teacher_name: nom.teacher_name,
          category: candidate.category,
          photo_used: photoUsed,
          category_icon_filename: icon.category_icon_filename,
          render_id: renderId,
          video_url: published.videoUrl,
          audio_attached: true,
          audio_filename: PRODUCTION_AUDIO_FILENAME,
        };
        successes.push(row);
        log(`  ok render_id=${renderId} photo_used=${photoUsed}`);
      } catch (err) {
        const message = errMessage(err);
        await NominationVideo.findOneAndUpdate(
          { nomination_id: nom._id },
          {
            $set: {
              nomination_id: nom._id,
              generation_status: "failed",
              generation_error: message.slice(0, 2000),
              ready_for_message: false,
            },
          },
          { upsert: true, new: true }
        ).catch(() => undefined);
        failures.push({
          nomination_id: nom._id,
          teacher_name: nom.teacher_name,
          category: candidate.category,
          error: message.slice(0, 500),
        });
        log(`  FAILED ${message.slice(0, 300)}`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const report = {
    production_batch_id: PRODUCTION_VIDEO_BATCH_ID,
    audio_filename: PRODUCTION_AUDIO_FILENAME,
    eligible: nominations.filter(isEligibleStudentVideo).length,
    skipped_already_final: skipped.length,
    attempted: planned.length,
    with_photo: successes.filter((s) => s.category === "with_photo").length,
    without_photo: successes.filter((s) => s.category === "without_photo").length,
    success: successes.length,
    failed: failures.length,
    audio_success: successes.length,
    audio_failed: failures.length,
    failures,
    videos: successes,
  };
  const reportPath = path.join(root, "output", "videos", "production-bulk-report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`DONE success=${successes.length} failed=${failures.length} skipped=${skipped.length}`);
  log(`Report: ${reportPath}`);
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(errMessage(err));
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
