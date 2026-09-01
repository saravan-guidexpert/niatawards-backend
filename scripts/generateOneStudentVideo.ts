/**
 * Generate exactly ONE student-nominated teacher video, then stop.
 * Usage: npx tsx scripts/generateOneStudentVideo.ts
 * Optional: NOMINATION_ID=<uuid>
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { Nomination } from "../src/models/Nomination";
import { NominationVideo } from "../src/models/NominationVideo";
import { isEligibleStudentVideo, hasTeacherPhoto } from "../src/lib/studentVideoEligibility";
import { nominationVideoDir } from "../src/routes/nominationVideos";

const PREFERRED_NOMINATION_ID = "1c4e6b10-03a4-4141-ad08-7ef7339c17f5";

const pythonBin = (root: string) => {
  const venv = path.join(root, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
};

const maskPhone = (value: unknown) => {
  const digits = String(value || "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return "(none)";
  return `${digits.slice(0, 2)}xxxxxx${digits.slice(-2)}`;
};

const publicBase = () =>
  (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, "");

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
  if (!nomination || !isEligibleStudentVideo(nomination) || !hasTeacherPhoto(nomination.photo_url)) {
    nomination = await Nomination.findOne({
      ...eligibleQuery,
      photo_url: { $type: "string", $ne: "" },
    }).sort({ created_at: -1 });
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
  const photoUrl = String(nomination.photo_url || "").trim();

  console.log("Selected nomination");
  console.log("  nomination_id:", nominationId);
  console.log("  teacher_name:", teacherName);
  console.log("  student_name:", studentName);
  console.log("  teacher_phone:", maskPhone(nomination.phone));
  console.log("  student_phone:", maskPhone(nomination.nominator_phone));
  console.log("  photo_available:", Boolean(photoUrl));

  const root = path.resolve(__dirname, "../../bg-remove");
  const pipelineOut = path.join(root, "output", "videos", `${nominationId}.mp4`);
  const serveDir = nominationVideoDir();
  fs.mkdirSync(path.dirname(pipelineOut), { recursive: true });
  fs.mkdirSync(serveDir, { recursive: true });
  const serveOut = path.join(serveDir, `${nominationId}.mp4`);
  const jobPath = path.join(root, "work", `${nominationId}.job.json`);
  const resultPath = path.join(root, "work", nominationId, "result.json");
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(
    jobPath,
    JSON.stringify(
      {
        nomination_id: nominationId,
        teacher_name: teacherName,
        nominator_name: studentName,
        photo_url: photoUrl,
        output: pipelineOut,
        result: resultPath,
      },
      null,
      2
    )
  );

  const py = spawnSync(
    pythonBin(root),
    [path.join(root, "generate_one_nomination.py"), jobPath],
    {
      encoding: "utf8",
      cwd: root,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  const stdout = (py.stdout || "").trim();
  let payload: Record<string, unknown> = {};
  if (fs.existsSync(resultPath)) {
    try {
      payload = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    } catch {
      payload = { error: stdout || py.stderr };
    }
  } else {
    payload = { error: stdout || py.stderr };
  }

  if (py.status === 2) {
    console.error("Asset inspection failed:", payload.error || stdout || py.stderr);
    await mongoose.disconnect();
    process.exit(2);
    return;
  }

  if (py.status !== 0) {
    await NominationVideo.findOneAndUpdate(
      { nomination_id: nominationId },
      {
        nomination_id: nominationId,
        generation_status: "failed",
        review_status: "none",
        video_url: null,
        ready_for_message: false,
        generation_error: String(payload.error || py.stderr || "render failed").slice(0, 2000),
      },
      { upsert: true, new: true }
    );
    console.error("Render failed:", payload.error || py.stderr);
    await mongoose.disconnect();
    process.exit(1);
    return;
  }

  fs.copyFileSync(pipelineOut, serveOut);
  const videoUrl = `${publicBase()}/api/nomination-videos/${nominationId}.mp4`;
  const record = await NominationVideo.findOneAndUpdate(
    { nomination_id: nominationId },
    {
      nomination_id: nominationId,
      generation_status: "generated",
      review_status: "ready_for_review",
      video_url: videoUrl,
      generated_at: new Date(),
      ready_for_message: false,
      generation_error: null,
      approved_at: null,
      rejected_at: null,
      rejection_reason: null,
    },
    { upsert: true, new: true }
  );

  console.log("Generated:", pipelineOut);
  console.log("Served copy:", serveOut);
  console.log("video_url:", videoUrl);
  console.log("NominationVideo:", {
    nomination_id: record?.nomination_id,
    generation_status: record?.generation_status,
    review_status: record?.review_status,
    ready_for_message: record?.ready_for_message,
    video_url: record?.video_url,
  });
  console.log("probe:", JSON.stringify(payload.validation || payload.reference || {}, null, 2));
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
