/**
 * Diagnoses the teacher photo and nomination video pipelines before a bulk run.
 *
 * Usage:
 *   npx tsx scripts/checkGenerationHealth.ts              # read-only report
 *   npx tsx scripts/checkGenerationHealth.ts --repair     # clear failures caused by env faults
 *   npx tsx scripts/checkGenerationHealth.ts --render     # also render one real video
 *   npx tsx scripts/checkGenerationHealth.ts --portrait   # also generate one real photo
 *   NOMINATION_ID=<uuid> / TEACHER_PHONE=<10 digits> pin the smoke-test subject
 */
import { loadBackendEnv, bgRemoveRoot, backendRoot, nominationVideoDir } from "../src/lib/projectPaths";
import dotenv from "dotenv";

dotenv.config({ path: loadBackendEnv() });

import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { NominationVideo } from "../src/models/NominationVideo";
import { TeacherPortrait } from "../src/models/TeacherPortrait";
import { VideoGenerationJob, VideoGenerationJobItem } from "../src/models/VideoGenerationJob";
import { assertVideoRenderReady } from "../src/lib/renderTeacherVideo";
import { generateFinalizedPortrait, portraitConfigError } from "../src/lib/generateFinalizedPortrait";
import { generateNominationVideo } from "../src/lib/generateNominationVideo";

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(28)} ${String(value)}`);

const groupCount = async (
  model: { aggregate: (pipeline: unknown[]) => { exec: () => Promise<Array<{ _id: unknown; n: number }>> } },
  field: string
) => {
  const rows = await model
    .aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
    .exec();
  return rows.map((row) => `${String(row._id ?? "(unset)")}=${row.n}`).join("  ");
};

const main = async () => {
  console.log("Environment");
  line("backend root", backendRoot());
  line("OPENAI_API_KEY", process.env.OPENAI_API_KEY ? "set" : "MISSING");
  line("CLOUDINARY_CLOUD_NAME", process.env.CLOUDINARY_CLOUD_NAME || "MISSING");
  line("nomination video dir", nominationVideoDir());
  try {
    line("bg-remove root", bgRemoveRoot());
  } catch (err) {
    line("bg-remove root", `ERROR ${err instanceof Error ? err.message : err}`);
  }

  console.log("\nPreflight");
  const portraitError = portraitConfigError();
  line("photo generation", portraitError ? `BLOCKED ${portraitError}` : "ready");
  let renderReady = true;
  try {
    assertVideoRenderReady();
    line("video renderer", "ready");
  } catch (err) {
    renderReady = false;
    line("video renderer", `BLOCKED ${err instanceof Error ? err.message : err}`);
  }

  await connectDB();
  console.log("\nDatabase");
  line("portraits by status", await groupCount(TeacherPortrait as never, "portrait_status"));
  line("videos by status", await groupCount(NominationVideo as never, "generation_status"));
  line("job items by status", await groupCount(VideoGenerationJobItem as never, "status"));

  const stuck = await VideoGenerationJobItem.countDocuments({
    status: "PROCESSING",
    started_at: { $lt: new Date(Date.now() - 10 * 60 * 1000) },
  });
  line("stalled job items", stuck);

  const recentFailures = await VideoGenerationJobItem.find({ status: "FAILED" })
    .sort({ completed_at: -1 })
    .limit(5)
    .select("nomination_id failure_stage error")
    .lean();
  if (recentFailures.length) {
    console.log("\nMost recent video failures");
    for (const row of recentFailures) {
      console.log(`  ${row.nomination_id} [${row.failure_stage}] ${String(row.error || "").slice(0, 160)}`);
    }
  }

  const jobs = await VideoGenerationJob.find({}).sort({ created_at: -1 }).limit(3).lean();
  if (jobs.length) {
    console.log("\nRecent jobs");
    for (const job of jobs) {
      console.log(
        `  #${job.job_number} ${job.status} ${job.mode} total=${job.total} done=${job.completed} failed=${job.failed}`
      );
    }
  }

  if (process.argv.includes("--repair")) {
    console.log("\nRepair");
    const envFault = [
      /Missing OPENAI_API_KEY/i,
      /Cloudinary is not configured/i,
      /bg-remove/i,
      /missing category icon directory/i,
      /no such file or directory, mkdir/i,
    ];
    const portraits = await TeacherPortrait.updateMany(
      { portrait_status: "FAILED", portrait_error: { $in: envFault } },
      { $set: { portrait_status: "PENDING", portrait_error: null } }
    );
    line("portraits cleared", portraits.modifiedCount);

    const stalePortraits = await TeacherPortrait.updateMany(
      { portrait_status: "PROCESSING", updated_at: { $lt: new Date(Date.now() - 8 * 60 * 1000) } },
      { $set: { portrait_status: "PENDING", portrait_error: null } }
    );
    line("stalled claims cleared", stalePortraits.modifiedCount);

    const videos = await NominationVideo.updateMany(
      { generation_status: "failed", generation_error: { $in: envFault } },
      { $set: { generation_status: "pending", generation_error: null } }
    );
    line("videos cleared", videos.modifiedCount);

    const staleItems = await VideoGenerationJobItem.updateMany(
      { status: "PROCESSING", started_at: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
      { $set: { status: "QUEUED", started_at: null, error: "Requeued by health repair" } }
    );
    line("job items requeued", staleItems.modifiedCount);
  }

  if (process.argv.includes("--portrait")) {
    const forced = String(process.env.TEACHER_PHONE || "").trim();
    const target =
      forced ||
      String(
        (
          await TeacherPortrait.findOne({
            portrait_status: { $in: ["PENDING", "FAILED"] },
            source_photo_url: { $nin: [null, ""] },
            teacher_phone: { $not: /^(\d)\1{9}$/ },
          })
            .select("teacher_phone")
            .lean()
        )?.teacher_phone || ""
      );
    console.log(`\nLive photo smoke test: ${target || "(none)"}`);
    if (target) {
      const started = Date.now();
      const result = await generateFinalizedPortrait({ phone: target, regenerate: true });
      line("elapsed", `${Math.round((Date.now() - started) / 1000)}s`);
      line("result", JSON.stringify(result).slice(0, 400));
    }
  }

  if (process.argv.includes("--render")) {
    if (!renderReady) {
      console.log("\nSkipping live render: preflight is blocked.");
    } else {
      const forced = String(process.env.NOMINATION_ID || "").trim();
      const target =
        forced ||
        String(
          (
            await VideoGenerationJobItem.findOne({ status: "FAILED" })
              .sort({ completed_at: -1 })
              .select("nomination_id")
              .lean()
          )?.nomination_id || ""
        );
      if (!target) {
        console.log("\nSkipping live render: no nomination to test.");
      } else {
        console.log(`\nLive render smoke test: ${target}`);
        const started = Date.now();
        try {
          const result = await generateNominationVideo({ nominationId: target, regenerate: true });
          line("render", `ok in ${Math.round((Date.now() - started) / 1000)}s`);
          line("photo used", result.photo_used);
          line("video url", result.video_url);
        } catch (err) {
          line("render", `FAILED ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
