/**
 * Regenerates teacher portraits whose last failure was recoverable.
 *
 * Skips OpenAI safety rejections, which need a different source photo picked
 * in Teacher Photo Management rather than another identical attempt.
 *
 * Usage: npx tsx scripts/retryFailedTeacherPortraits.ts [--limit 50]
 */
import { loadBackendEnv } from "../src/lib/projectPaths";
import dotenv from "dotenv";

dotenv.config({ path: loadBackendEnv() });

import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { TeacherPortrait } from "../src/models/TeacherPortrait";
import { generateFinalizedPortrait, portraitConfigError } from "../src/lib/generateFinalizedPortrait";

const PERMANENT = /safety system|placeholder phone|not a unique teacher identity/i;

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : "";
};

const main = async () => {
  const blocked = portraitConfigError();
  if (blocked) {
    console.error(blocked);
    process.exit(1);
  }
  await connectDB();

  const limit = Math.max(1, Number(arg("--limit")) || 1000);
  const rows = await TeacherPortrait.find({ portrait_status: "FAILED" })
    .select("teacher_phone teacher_name portrait_error")
    .lean();
  const queue = rows
    .filter((row) => !PERMANENT.test(String(row.portrait_error || "")))
    .filter((row) => !/^(\d)\1{9}$/.test(String(row.teacher_phone || "")))
    .slice(0, limit);

  console.log(`${rows.length} failed portraits, ${queue.length} recoverable`);

  let ok = 0;
  let failed = 0;
  for (const [index, row] of queue.entries()) {
    const phone = String(row.teacher_phone || "");
    const started = Date.now();
    try {
      const result = await generateFinalizedPortrait({ phone, regenerate: true });
      const seconds = Math.round((Date.now() - started) / 1000);
      if (result.ok && !result.skipped) {
        ok += 1;
        console.log(`[${index + 1}/${queue.length}] ${phone} ok ${seconds}s`);
      } else {
        failed += 1;
        const reason = "error" in result ? result.error : "reason" in result ? result.reason : "skipped";
        console.log(`[${index + 1}/${queue.length}] ${phone} ${String(reason).slice(0, 140)}`);
      }
    } catch (err) {
      failed += 1;
      console.log(`[${index + 1}/${queue.length}] ${phone} threw ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone. generated=${ok} still_failing=${failed}`);
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
