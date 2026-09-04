/**
 * Live DB checks for Teacher Video Messaging. Does not send WhatsApp.
 */
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { AfterSessionNomination } from "../src/models/AfterSessionNomination";
import { Nomination } from "../src/models/Nomination";
import { NominationVideo } from "../src/models/NominationVideo";
import { WhatsAppMessageEvent } from "../src/models/WhatsAppMessageEvent";
import { existingVideoDeliveryDecision } from "../src/lib/nominationVideoWhatsApp";
import {
  listTeacherVideoMessages,
  previewTeacherVideoQueue,
  progressForEventIds,
  summarizeTeacherVideoMessages,
  VIDEO_MESSAGING_TEST_PHONE,
} from "../src/lib/teacherVideoMessaging";

const TEST_VIDEOS = {
  student: "2d3f37ea-5223-4c6c-b77c-77ca0fdb11a2",
  colleague: "0f15011d-a6e4-418f-af99-17a49ce596cc",
  teacher: "5d6fce04-eb37-4072-a5d6-bec72091cce0",
};

const fail = (message: string): never => {
  throw new Error(message);
};

const main = async () => {
  await connectDB();
  const results: Record<string, string> = {};

  const summary = await summarizeTeacherVideoMessages({});
  if (summary.totalGenerated < 1) fail("summary.totalGenerated should include generated videos");
  results.summary = JSON.stringify(summary);

  const testRows = await listTeacherVideoMessages({ testOnly: true, limit: 25 });
  const kinds = new Set(testRows.items.map((row) => row.nominationKind));
  if (!kinds.has("student") || !kinds.has("teacher") || !kinds.has("colleague")) {
    fail(`TEST rows missing kinds. found=${[...kinds].join(",")}`);
  }
  for (const row of testRows.items) {
    if (!row.isTest) fail(`testOnly list included non-test ${row.nominationVideoId}`);
    if (row.teacherPhone !== VIDEO_MESSAGING_TEST_PHONE) fail("TEST row phone was rewritten or missing");
  }
  if (testRows.items.some((row) => row.nominationId === "9e13fa58-553f-4941-a884-8749a19b1007")) {
    fail("draft nomination appeared in messaging list");
  }
  results.testRows = `${testRows.items.length} rows, kinds=${[...kinds].join(",")}`;

  const afterIds = (await AfterSessionNomination.find({}).select("_id").limit(50).lean()).map((doc) => String(doc._id));
  const leakedVideos = afterIds.length
    ? await NominationVideo.countDocuments({ nomination_id: { $in: afterIds } })
    : 0;
  if (leakedVideos > 0) fail("AfterSessionNomination IDs must never have NominationVideo rows");
  const leakedList = testRows.items.filter((row) => afterIds.includes(row.nominationId));
  if (leakedList.length) fail("AfterSession IDs appeared in messaging list");
  results.afterSession = `after_session_nominations=${afterIds.length} leakedVideos=${leakedVideos}`;

  const preview = await previewTeacherVideoQueue(Object.values(TEST_VIDEOS));
  if (preview.total !== 3) fail(`preview total expected 3, got ${preview.total}`);
  if (preview.ready !== 3) fail("TEST videos must be resendable after delivered/read");
  if (preview.testCount !== 3) fail("expected 3 TEST rows");
  if (preview.byKind.student !== 1 || preview.byKind.teacher !== 1 || preview.byKind.colleague !== 1) {
    fail("preview must treat the three TEST videos as separate nomination kinds");
  }
  results.preview = JSON.stringify(preview);

  const colleague = testRows.items.find((row) => row.nominationId === "9234d465-dcb9-4950-9d83-1dba2e5e8508");
  if (!colleague?.canSend) fail("colleague TEST row must keep Send available after delivered");
  if (testRows.items.some((row) => row.isTest && row.messageStatus !== "queued" && !row.canSend)) {
    fail("TEST rows that are not queued must remain sendable");
  }

  const deliveries = await WhatsAppMessageEvent.find({ nominationVideoId: TEST_VIDEOS.student });
  if (deliveries.length !== 1) fail(`expected exactly 1 delivery for student TEST video, got ${deliveries.length}`);
  results.duplicate = `deliveries=${deliveries.length} (unique nominationVideoId retained)`;

  if (existingVideoDeliveryDecision({ status: "delivered", phone: "9483204012" }, true) !== "duplicate") {
    fail("production delivered+retry must stay duplicate");
  }
  if (existingVideoDeliveryDecision({ status: "delivered", phone: VIDEO_MESSAGING_TEST_PHONE }, false) !== "retry") {
    fail("TEST delivered must be resendable");
  }
  if (existingVideoDeliveryDecision({ status: "failed" }, true) !== "retry") {
    fail("failed+retry must reuse the same delivery record");
  }
  results.retry = "test phone resend allowed; production delivered blocked";

  const multi = await listTeacherVideoMessages({ q: "9483204012", limit: 25 });
  const keys = new Set(multi.items.map((row) => row.messagingKey));
  const groupedKinds = new Set(multi.items.map((row) => row.nominationKind));
  if (multi.items.length > 3) fail(`teacher+kind must collapse to at most 3 rows, got ${multi.items.length}`);
  if (keys.size !== multi.items.length) fail("duplicate teacher+kind rows in messaging list");
  if (!groupedKinds.size) fail("grouped teacher rows missing");
  results.sameTeacherSeparateVideos = `rows=${multi.items.length} kinds=${[...groupedKinds].join(",")} videoCounts=${multi.items.map((r) => r.videoCount).join("/")}`;

  const eventIds = (
    await WhatsAppMessageEvent.find({ nominationVideoId: { $in: Object.values(TEST_VIDEOS) } })
      .select("_id")
      .lean()
  ).map((doc) => String(doc._id));
  const progress = await progressForEventIds(eventIds);
  if (progress.total !== 3) fail(`progress total expected 3, got ${progress.total}`);
  results.progress = JSON.stringify(progress);

  const opsEvents = await WhatsAppMessageEvent.find({ nominationVideoId: { $in: Object.values(TEST_VIDEOS) } }).lean();
  if (opsEvents.some((doc) => !doc.nominationVideoId || !doc.nominationId)) {
    fail("existing WhatsApp Messaging records are missing nomination video identity");
  }
  results.sharedRecords = `events=${opsEvents.length} statuses=${opsEvents.map((d) => d.status).join(",")}`;

  const newest = await NominationVideo.findOne({ generation_status: "generated", video_url: { $regex: /^https:\/\//i } })
    .sort({ generated_at: -1 })
    .lean();
  if (!newest) fail("no generated videos");
  const listedNewest = await listTeacherVideoMessages({ q: String(newest.nomination_id), limit: 5 });
  if (!listedNewest.items.some((row) => row.nominationVideoId === String(newest._id))) {
    fail("newest generated video did not appear in live list");
  }
  results.liveList = `newest=${String(newest._id)} generated_at=${String(newest.generated_at)}`;

  const draftNom = await Nomination.findById("9e13fa58-553f-4941-a884-8749a19b1007").lean();
  if (draftNom && String(draftNom.status) === "draft") {
    const draftList = await listTeacherVideoMessages({ q: "9e13fa58-553f-4941-a884-8749a19b1007", limit: 10 });
    if (draftList.items.length) fail("draft nomination leaked into messaging list");
  }

  console.log(JSON.stringify({ ok: true, results }, null, 2));
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error("VALIDATION FAIL:", err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
