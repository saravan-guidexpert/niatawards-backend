/**
 * Generate exactly ONE student-nominated teacher video, then stop.
 * Uses the MATCH cropped TeacherPortrait when mapping allows it.
 * Never generates or crops teacher portraits — those come from Teacher Image Management.
 * Unique render_id / output / Cloudinary public_id. Never rembg original photo_url.
 * Usage: npx tsx scripts/generateOneStudentVideo.ts
 * Optional: NOMINATION_ID=<uuid>
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { Nomination } from "../src/models/Nomination";
import { NominationVideo } from "../src/models/NominationVideo";
import { TeacherPortrait } from "../src/models/TeacherPortrait";
import { isEligibleStudentVideo } from "../src/lib/studentVideoEligibility";
import { phone10, resolveTeacherPortrait } from "../src/lib/resolveTeacherPortrait";
import {
  encodeTeacherVideo,
  materializeCroppedPortrait,
  newVideoRenderId,
  publishTeacherVideo,
  renderPaths,
  bgRemoveRoot,
} from "../src/lib/renderTeacherVideo";
import { pickRandomCategoryIcon, rasterizeCategoryIcon } from "../src/lib/categoryIcons";

const PREFERRED_NOMINATION_ID = "1c4e6b10-03a4-4141-ad08-7ef7339c17f5";

const maskPhone = (value: unknown) => {
  const digits = String(value || "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return "(none)";
  return `${digits.slice(0, 2)}xxxxxx${digits.slice(-2)}`;
};

const eligibleQuery = {
  type: "student",
  status: { $ne: "draft" },
};

const main = async () => {
  await connectDB();

  const forced = String(process.env.NOMINATION_ID || "").trim();
  let nomination = forced ? await Nomination.findById(forced) : null;

  if (!nomination || !isEligibleStudentVideo(nomination)) {
    nomination = await Nomination.findById(PREFERRED_NOMINATION_ID);
  }
  if (!nomination || !isEligibleStudentVideo(nomination)) {
    nomination = await Nomination.findOne(eligibleQuery).sort({ created_at: -1 });
  }

  if (!nomination || !isEligibleStudentVideo(nomination)) {
    console.log("No eligible student nomination exists for test rendering.");
    await mongoose.disconnect();
    process.exit(2);
    return;
  }

  const nominationId = String(nomination._id);
  const teacherName = String(nomination.teacher_name || "").trim();
  const studentName = String(nomination.student_name || nomination.nominator_name || "").trim();
  const phone = phone10(nomination.phone);
  const portrait = phone
    ? await TeacherPortrait.findOne({ teacher_phone: phone })
    : null;
  const resolved = resolveTeacherPortrait(nomination.toJSON(), portrait?.toJSON() || null);
  const usePortrait = resolved.mapping === "MATCH" && resolved.usable && Boolean(resolved.portrait_cloudinary_url);

  console.log("Selected nomination");
  console.log("  nomination_id:", nominationId);
  console.log("  teacher_name:", teacherName);
  console.log("  student_name:", studentName);
  console.log("  teacher_phone:", maskPhone(nomination.phone));
  console.log("  mapping:", resolved.mapping, resolved.reason);
  console.log("  photo_used:", usePortrait);

  const renderId = newVideoRenderId();
  const root = bgRemoveRoot();
  const paths = renderPaths(root, nominationId, renderId);
  fs.mkdirSync(paths.renderDir, { recursive: true });
  const icon = pickRandomCategoryIcon(root);
  const iconPng = path.join(paths.renderDir, "category-icon.png");
  rasterizeCategoryIcon(icon.svgPath, iconPng);
  console.log("  category_icon:", icon.category_icon_filename);
  let preparedPath = "";
  if (usePortrait) {
    preparedPath = await materializeCroppedPortrait({
      dest: paths.preparedPath,
      localPath: resolved.cropped_local_png_path,
      cloudinaryUrl: resolved.portrait_cloudinary_url,
    });
  }

  try {
    const encoded = await encodeTeacherVideo({
      nominationId,
      teacherName,
      nominatorName: studentName,
      renderId,
      preparedPortraitPath: preparedPath || null,
      categoryIconPath: iconPng,
      categoryIconId: icon.category_icon_id,
      categoryIconFilename: icon.category_icon_filename,
    });
    const published = await publishTeacherVideo(encoded, nominationId);
    const record = await NominationVideo.findOneAndUpdate(
      { nomination_id: nominationId },
      {
        nomination_id: nominationId,
        generation_status: "generated",
        review_status: "ready_for_review",
        video_url: published.videoUrl,
        video_render_id: renderId,
        generated_at: new Date(),
        ready_for_message: false,
        generation_error: null,
        approved_at: null,
        rejected_at: null,
        rejection_reason: null,
        portrait_cloudinary_url: usePortrait ? resolved.portrait_cloudinary_url : null,
        photo_used: Boolean(usePortrait),
        category_icon_id: icon.category_icon_id,
        category_icon_filename: icon.category_icon_filename,
      },
      { upsert: true, new: true }
    );

    console.log("Generated:", published.outputPath);
    console.log("render_id:", renderId);
    console.log("video_url:", published.videoUrl);
    console.log("placement:", JSON.stringify(published.payload.placement || null));
    console.log("NominationVideo:", {
      nomination_id: record?.nomination_id,
      generation_status: record?.generation_status,
      review_status: record?.review_status,
      ready_for_message: record?.ready_for_message,
      video_url: record?.video_url,
      video_render_id: record?.video_render_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await NominationVideo.findOneAndUpdate(
      { nomination_id: nominationId },
      {
        nomination_id: nominationId,
        generation_status: "failed",
        review_status: "none",
        video_url: null,
        video_render_id: null,
        ready_for_message: false,
        generation_error: message.slice(0, 2000),
      },
      { upsert: true, new: true }
    );
    console.error("Render failed:", message);
    await mongoose.disconnect();
    process.exit(1);
    return;
  }

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
