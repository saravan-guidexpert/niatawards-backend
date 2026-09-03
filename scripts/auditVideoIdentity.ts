/**
 * Read-only video identity audit. Does not delete or overwrite NominationVideo records.
 *
 * Usage: npx tsx scripts/auditVideoIdentity.ts
 */
import { loadBackendEnv } from "../src/lib/projectPaths";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: loadBackendEnv() });

import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { Nomination } from "../src/models/Nomination";
import { NominationVideo } from "../src/models/NominationVideo";
import { isSubmittedNomination, nominationKind, photoStateOf, teacherDisplayName, usableTeacherPhone } from "../src/lib/nominationKind";
import {
  buildVideoUrlOwners,
  videoIdentityMismatch,
  videoPathNominationId,
  videoSatisfiesNomination,
} from "../src/lib/videoIdentity";

const outFile = path.resolve(__dirname, "../storage/video-identity-audit.json");

const main = async () => {
  await connectDB();
  const nominations = await Nomination.find({ status: { $ne: "draft" } })
    .select("_id type student_class phone teacher_name full_name nominator_name photo_url")
    .lean();
  const videos = await NominationVideo.find({})
    .select(
      "nomination_id generation_status video_url video_render_id nomination_kind video_template generation_error"
    )
    .lean();
  const videoByNom = new Map(videos.map((v) => [String(v.nomination_id), v]));
  const submitted = nominations.filter((n) => isSubmittedNomination(n));

  const urlOwners = buildVideoUrlOwners(
    submitted.map((n) => {
      const video = videoByNom.get(String(n._id));
      return {
        nomination_id: String(n._id),
        kind: nominationKind(n),
        video_url: video?.video_url,
        generation_status: video?.generation_status,
      };
    })
  );

  const mismatches: Record<string, unknown>[] = [];
  const byKind: Record<string, { nominations: number; generated: number; mismatch: number }> = {
    student: { nominations: 0, generated: 0, mismatch: 0 },
    teacher: { nominations: 0, generated: 0, mismatch: 0 },
    colleague: { nominations: 0, generated: 0, mismatch: 0 },
  };

  const phonesByKind = new Map<string, Set<NominationKind>>();
  for (const n of submitted) {
    const id = String(n._id);
    const kind = nominationKind(n);
    const photo = photoStateOf(n.photo_url);
    const phone = usableTeacherPhone(n.phone);
    byKind[kind].nominations += 1;
    if (phone) {
      const set = phonesByKind.get(phone) || new Set();
      set.add(kind);
      phonesByKind.set(phone, set);
    }
    const video = videoByNom.get(id) || null;
    const mismatch = video
      ? videoIdentityMismatch({
          video,
          nominationId: id,
          expectedKind: kind,
          urlOwners,
        })
      : null;
    const satisfies = videoSatisfiesNomination({
      video,
      nominationId: id,
      expectedKind: kind,
      urlOwners,
    });
    if (satisfies) byKind[kind].generated += 1;
    if (mismatch && String(video?.generation_status || "") === "generated") {
      byKind[kind].mismatch += 1;
      mismatches.push({
        nomination_id: id,
        nomination_type: n.type || null,
        teacher_name: teacherDisplayName(n),
        teacher_phone: phone || n.phone || null,
        video_id: video?._id || null,
        video_url: video?.video_url || null,
        video_nomination_id: video?.nomination_id || null,
        video_render_id: video?.video_render_id || null,
        path_nomination_id: videoPathNominationId(video?.video_url),
        expected_category: `${kind}_${photo}`,
        actual_video_category: video?.nomination_kind || video?.video_template || "unlabeled_legacy",
        mismatch_reason: mismatch,
      });
    }
  }

  const crossCategoryTeachers = [...phonesByKind.entries()]
    .filter(([, kinds]) => kinds.has("student") && kinds.has("teacher") && kinds.has("colleague"))
    .map(([phone, kinds]) => ({ phone, kinds: [...kinds] }));

  const validationTeacher = crossCategoryTeachers[0]
    ? submitted.filter((n) => usableTeacherPhone(n.phone) === crossCategoryTeachers[0].phone)
    : [];

  const validation = validationTeacher.map((n) => {
    const id = String(n._id);
    const kind = nominationKind(n);
    const video = videoByNom.get(id) || null;
    return {
      nomination_id: id,
      nomination_type: n.type || null,
      expected_kind: kind,
      teacher_name: teacherDisplayName(n),
      teacher_phone: usableTeacherPhone(n.phone),
      video_id: video?._id || null,
      video_url: video?.video_url || null,
      video_render_id: video?.video_render_id || null,
      satisfies: videoSatisfiesNomination({
        video,
        nominationId: id,
        expectedKind: kind,
        urlOwners,
      }),
      mismatch: video
        ? videoIdentityMismatch({
            video,
            nominationId: id,
            expectedKind: kind,
            urlOwners,
          })
        : "no_video",
    };
  });

  const report = {
    generated_at: new Date().toISOString(),
    note: "Records are preserved. Mismatched videos are not displayed as that category's video and are not counted generated.",
    byKind,
    mismatch_count: mismatches.length,
    cross_category_teachers: crossCategoryTeachers.length,
    validation_phone: crossCategoryTeachers[0]?.phone || null,
    validation,
    mismatches: mismatches.slice(0, 200),
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, mismatches: `${mismatches.length} (first 200 written to file)` }, null, 2));
  console.log(`Wrote ${outFile}`);
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
