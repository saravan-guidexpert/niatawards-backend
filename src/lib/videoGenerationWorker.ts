import {
  VideoGenerationJob,
  VideoGenerationJobItem,
  type VideoFailureStage,
  type VideoJobCurrent,
  type VideoJobMode,
  type VideoJobRecentItem,
  type VideoJobType,
} from "../models/VideoGenerationJob";
import { TeacherPortrait } from "../models/TeacherPortrait";
import { Nomination } from "../models/Nomination";
import { NominationVideo, PRODUCTION_AUDIO_FILENAME } from "../models/NominationVideo";
import {
  generateNominationVideo,
  markNominationVideoBlocked,
  markNominationVideoFailed,
  VideoPipelineError,
} from "./generateNominationVideo";
import { generateFinalizedPortrait, ensureVerifiedProductionPortrait } from "./generateFinalizedPortrait";
import { isVerifiedProductionCrop, nominationKind, photoStateOf } from "./nominationKind";
import { videoProductionValid, videoProductionValidity } from "./videoIdentity";
import { assertVideoRenderReady } from "./renderTeacherVideo";
import type {
  CategoryTeacher,
  CatalogPortrait,
  CatalogVideo,
  VideoLiveStatus,
} from "./teacherPortraitCatalog";

const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.VIDEO_WORKER_CONCURRENCY || 2) || 2));
const RECENT_LIMIT = 8;
const ROLLING = 20;

let pumping = false;

const stageOf = (err: unknown): VideoFailureStage =>
  err instanceof VideoPipelineError ? err.stage : "VIDEO_RENDER";

const messageOf = (err: unknown) =>
  err instanceof Error && err.message ? err.message.slice(0, 2000) : String(err).slice(0, 2000);

export type PlannedVideo = {
  nomination_id: string;
  teacher_phone: string;
  teacher_name: string;
  category_id: string;
  photo_used: boolean;
};

export const planVideosForTeachers = (opts: {
  teachers: CategoryTeacher[];
  portraits: Map<string, CatalogPortrait>;
  videos: Map<string, CatalogVideo>;
  regenerate: boolean;
  nominationIds?: string[];
  includePortraits?: boolean;
  live?: Map<string, VideoLiveStatus>;
}): {
  queued: PlannedVideo[];
  blocked: PlannedVideo[];
  teacher_count: number;
  eligible_nominations: number;
  already_generated: number;
  blocked_missing_portrait: number;
  invalid_will_regenerate: number;
  already_queued: number;
} => {
  const queued: PlannedVideo[] = [];
  const blocked: PlannedVideo[] = [];
  let eligible = 0;
  let already = 0;
  let invalid = 0;
  let alreadyQueued = 0;
  const idFilter = opts.nominationIds?.length ? new Set(opts.nominationIds) : null;
  const selectedPhones = new Set(opts.teachers.map((t) => t.phone));

  for (const teacher of opts.teachers) {
    const portrait = opts.portraits.get(teacher.phone);
    const verified = isVerifiedProductionCrop(portrait);
    const imageReady = teacher.photo === "without_photo" || (!teacher.missing_phone && verified);
    const canGenerateImage =
      Boolean(opts.includePortraits) && teacher.photo === "with_photo" && !teacher.missing_phone;
    const ids = idFilter
      ? teacher.nomination_ids.filter((id) => idFilter.has(id))
      : teacher.nomination_ids;
    for (const nominationId of ids) {
      eligible += 1;
      const liveStatus = opts.live?.get(nominationId);
      if (!opts.regenerate && (liveStatus === "QUEUED" || liveStatus === "PROCESSING")) {
        alreadyQueued += 1;
        continue;
      }
      const existing = opts.videos.get(nominationId);
      const productionValid = videoProductionValid({
        video: existing,
        nominationId,
        expectedKind: teacher.kind,
        expectedPhoto: teacher.photo,
      });
      if (!opts.regenerate && productionValid) {
        already += 1;
        continue;
      }
      const row: PlannedVideo = {
        nomination_id: nominationId,
        teacher_phone: teacher.phone,
        teacher_name: teacher.name,
        category_id: teacher.category_id,
        photo_used: teacher.photo === "with_photo",
      };
      if (teacher.photo === "without_photo" || imageReady || canGenerateImage) {
        if (
          existing &&
          String(existing.generation_status || "") === "generated" &&
          !productionValid
        ) {
          invalid += 1;
        }
        queued.push(row);
        continue;
      }
      blocked.push(row);
    }
  }

  return {
    queued,
    blocked,
    teacher_count: selectedPhones.size,
    eligible_nominations: eligible,
    already_generated: already,
    blocked_missing_portrait: blocked.length,
    invalid_will_regenerate: invalid,
    already_queued: alreadyQueued,
  };
};

const nextJobNumber = async () => {
  const last = await VideoGenerationJob.findOne().sort({ job_number: -1 }).select("job_number").lean();
  return Math.max(1001, Number(last?.job_number || 1000) + 1);
};

const recountJob = async (jobId: string) => {
  const [queued, processing, completed, failed, blocked, cancelled] = await Promise.all([
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "QUEUED" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "PROCESSING" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "COMPLETED" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "FAILED" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "BLOCKED" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "CANCELLED" }),
  ]);
  const job = await VideoGenerationJob.findById(jobId).lean();
  if (!job) return null;
  const update: Record<string, unknown> = { queued, processing, completed, failed, blocked, cancelled };
  const remaining = queued + processing;
  if (remaining === 0 && (job.cancel_requested || job.total > 0)) {
    update.status = job.cancel_requested ? "cancelled" : "completed";
    update.completed_at = job.completed_at || new Date();
    update.current = null;
  }
  const updated = await VideoGenerationJob.findByIdAndUpdate(jobId, { $set: update }, { new: true });
  if (updated && (updated.status === "completed" || updated.status === "cancelled") && !updated.verification) {
    await verifyJobProduction(jobId).catch((err) => console.error("[video-worker] verification failed", err));
  }
  return updated;
};

/**
 * Records one finished item on the parent job. Two workers touch the same job
 * document, so this is an atomic pipeline update: a load-modify-save here would
 * lose an optimistic-concurrency race and fail a video that already rendered.
 */
const recordFinishedItem = async (jobId: string, row: VideoJobRecentItem, durationMs: number | null) => {
  const stages: Record<string, unknown>[] = [];
  if (durationMs !== null) {
    stages.push({
      $set: {
        recent_durations_ms: {
          $slice: [{ $concatArrays: [{ $ifNull: ["$recent_durations_ms", []] }, [durationMs]] }, -ROLLING],
        },
      },
    });
    stages.push({ $set: { avg_ms: { $round: [{ $avg: "$recent_durations_ms" }, 0] } } });
  }
  stages.push({
    $set: {
      recent: { $slice: [{ $concatArrays: [[row], { $ifNull: ["$recent", []] }] }, RECENT_LIMIT] },
    },
  });
  await VideoGenerationJob.findByIdAndUpdate(jobId, stages);
};

export const createVideoGenerationJob = async (opts: {
  mode: VideoJobMode;
  category_id: string;
  kind: string;
  photo: string;
  planned: PlannedVideo[];
  blocked?: PlannedVideo[];
  created_by?: string | null;
  job_type?: VideoJobType;
  include_portraits?: boolean;
  force_without_photo?: boolean;
}) => {
  const blocked = opts.blocked || [];
  if (!opts.planned.length && !blocked.length) {
    throw new Error("No nomination videos to queue");
  }
  const jobType = opts.job_type || (opts.include_portraits ? "image_plus_video" : "video");
  const job = await VideoGenerationJob.create({
    job_number: await nextJobNumber(),
    status: "running",
    mode: opts.mode,
    job_type: jobType,
    include_portraits: Boolean(opts.include_portraits),
    force_without_photo: Boolean(opts.force_without_photo),
    category_id: opts.category_id,
    kind: opts.kind,
    photo: opts.photo,
    teacher_count: new Set([...opts.planned, ...blocked].map((row) => row.teacher_phone)).size,
    total: opts.planned.length + blocked.length,
    queued: opts.planned.length,
    processing: 0,
    completed: 0,
    failed: 0,
    blocked: blocked.length,
    cancelled: 0,
    avg_ms: 0,
    recent_durations_ms: [],
    current: null,
    recent: [],
    cancel_requested: false,
    created_by: opts.created_by || null,
    started_at: new Date(),
  });
  const rows = [
    ...opts.planned.map((row) => ({
      job_id: job._id,
      nomination_id: row.nomination_id,
      teacher_name: row.teacher_name,
      teacher_phone: row.teacher_phone,
      category_id: row.category_id,
      photo_used: row.photo_used,
      status: "QUEUED" as const,
      audio_filename: PRODUCTION_AUDIO_FILENAME,
    })),
    ...blocked.map((row) => ({
      job_id: job._id,
      nomination_id: row.nomination_id,
      teacher_name: row.teacher_name,
      teacher_phone: row.teacher_phone,
      category_id: row.category_id,
      photo_used: row.photo_used,
      status: "BLOCKED" as const,
      error: "BLOCKED — PORTRAIT NOT READY",
      failure_stage: "PORTRAIT_RESOLUTION" as const,
      audio_filename: PRODUCTION_AUDIO_FILENAME,
    })),
  ];
  if (rows.length) await VideoGenerationJobItem.insertMany(rows);
  kickVideoWorker();
  return job;
};

export const createPortraitGenerationJob = async (opts: {
  mode: VideoJobMode;
  category_id: string;
  kind: string;
  photo: string;
  teachers: Array<{ phone: string; name: string; nomination_id: string }>;
  created_by?: string | null;
}) => {
  const unique = new Map<string, { phone: string; name: string; nomination_id: string }>();
  for (const row of opts.teachers) {
    if (!row.phone || unique.has(row.phone)) continue;
    unique.set(row.phone, row);
  }
  if (!unique.size) throw new Error("No teachers to queue for portrait generation");
  const planned = [...unique.values()].map((row) => ({
    nomination_id: row.nomination_id,
    teacher_phone: row.phone,
    teacher_name: row.name,
    category_id: opts.category_id,
    photo_used: true,
  }));
  return createVideoGenerationJob({
    ...opts,
    planned,
    job_type: "portrait",
    include_portraits: true,
  });
};

export const cancelQueuedVideoJob = async (jobId: string) => {
  const job = await VideoGenerationJob.findById(jobId);
  if (!job) return null;
  job.cancel_requested = true;
  await job.save();
  await VideoGenerationJobItem.updateMany(
    { job_id: jobId, status: { $in: ["QUEUED", "PROCESSING"] } },
    { $set: { status: "CANCELLED", completed_at: new Date(), error: "Cancelled" } }
  );
  await recountJob(jobId);
  return VideoGenerationJob.findById(jobId);
};

export const retryFailedVideoJob = async (jobId: string, createdBy?: string | null) => {
  const source = await VideoGenerationJob.findById(jobId).lean();
  if (!source) throw new Error("Job not found");
  const failed = await VideoGenerationJobItem.find({ job_id: jobId, status: "FAILED" }).lean();
  if (!failed.length) throw new Error("No failed videos to retry");
  return createVideoGenerationJob({
    mode: "retry",
    category_id: String(source.category_id || ""),
    kind: String(source.kind || ""),
    photo: String(source.photo || ""),
    created_by: createdBy || source.created_by,
    job_type: (source.job_type as VideoJobType) || "video",
    include_portraits: Boolean(source.include_portraits) || source.job_type === "image_plus_video",
    planned: failed.map((row) => ({
      nomination_id: row.nomination_id,
      teacher_phone: row.teacher_phone,
      teacher_name: row.teacher_name,
      category_id: row.category_id,
      photo_used: Boolean(row.photo_used),
    })),
  });
};

export const retryBlockedVideoJob = async (jobId: string, createdBy?: string | null) => {
  const source = await VideoGenerationJob.findById(jobId).lean();
  if (!source) throw new Error("Job not found");
  const blocked = await VideoGenerationJobItem.find({ job_id: jobId, status: "BLOCKED" }).lean();
  if (!blocked.length) throw new Error("No blocked nominations to retry");
  const phones = [...new Set(blocked.map((row) => row.teacher_phone).filter(Boolean))];
  const portraits = await TeacherPortrait.find({ teacher_phone: { $in: phones } }).lean();
  const verified = new Set(
    portraits.filter((p) => isVerifiedProductionCrop(p)).map((p) => String(p.teacher_phone || ""))
  );
  const ready = blocked.filter(
    (row) => !row.photo_used || verified.has(row.teacher_phone) || source.include_portraits || source.job_type === "image_plus_video"
  );
  if (!ready.length) throw new Error("No blocked nominations are ready yet");
  return createVideoGenerationJob({
    mode: "retry",
    category_id: String(source.category_id || ""),
    kind: String(source.kind || ""),
    photo: String(source.photo || ""),
    created_by: createdBy || source.created_by,
    job_type: (source.job_type as VideoJobType) || "video",
    include_portraits: Boolean(source.include_portraits) || source.job_type === "image_plus_video",
    planned: ready.map((row) => ({
      nomination_id: row.nomination_id,
      teacher_phone: row.teacher_phone,
      teacher_name: row.teacher_name,
      category_id: row.category_id,
      photo_used: Boolean(row.photo_used),
    })),
  });
};

/**
 * A render is killed after 2 minutes and Cloudinary times out at 3, so anything
 * still PROCESSING past this window belongs to a worker that died.
 */
const STALE_ITEM_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

const requeueStaleItems = async () => {
  const cancelledJobs = await VideoGenerationJob.find({ cancel_requested: true }).select("_id").lean();
  const cancelledIds = cancelledJobs.map((job) => String(job._id));
  if (cancelledIds.length) {
    await VideoGenerationJobItem.updateMany(
      { job_id: { $in: cancelledIds }, status: { $in: ["QUEUED", "PROCESSING"] } },
      { $set: { status: "CANCELLED", completed_at: new Date(), error: "Cancelled" } }
    );
    for (const id of cancelledIds) await recountJob(id);
  }
  const result = await VideoGenerationJobItem.updateMany(
    {
      status: "PROCESSING",
      started_at: { $lt: new Date(Date.now() - STALE_ITEM_MS) },
      ...(cancelledIds.length ? { job_id: { $nin: cancelledIds } } : {}),
    },
    { $set: { status: "QUEUED", started_at: null, error: "Requeued after a stalled render" } }
  );
  return Number(result?.modifiedCount || 0);
};

let jobRr = 0;

const claimFromJobs = async (jobs: Array<{ _id: unknown; job_type?: unknown }>, renderReady: boolean) => {
  if (!jobs.length) return null;
  const busy = await VideoGenerationJobItem.distinct("nomination_id", { status: "PROCESSING" });
  const start = Math.abs(jobRr) % jobs.length;
  jobRr += 1;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[(start + i) % jobs.length];
    if (job.job_type !== "portrait" && !renderReady) continue;
    const item = await VideoGenerationJobItem.findOneAndUpdate(
      {
        job_id: job._id,
        status: "QUEUED",
        ...(busy.length ? { nomination_id: { $nin: busy } } : {}),
      },
      { $set: { status: "PROCESSING", started_at: new Date(), error: null, failure_stage: null } },
      { new: true, sort: { created_at: 1 } }
    );
    if (item) return { item, jobType: (job.job_type as VideoJobType) || "video" };
  }
  return null;
};

const claimNextItem = async () => {
  const renderReady = canRenderVideos();
  const running = await VideoGenerationJob.find({ status: "running", cancel_requested: { $ne: true } })
    .sort({ started_at: 1 })
    .select("_id job_type photo")
    .lean();
  const videoJobs = running.filter((job) => (job.job_type || "video") !== "portrait");
  const withoutPhotoJobs = videoJobs.filter((job) => job.photo === "without_photo");
  const otherVideoJobs = videoJobs.filter((job) => job.photo !== "without_photo");
  const orderedVideoJobs = withoutPhotoJobs.length ? [...withoutPhotoJobs, ...otherVideoJobs] : videoJobs;
  const portraitJobs = running.filter((job) => job.job_type === "portrait");
  const processingItems = await VideoGenerationJobItem.find({ status: "PROCESSING" }).select("job_id").lean();
  const typeByJob = new Map(running.map((job) => [String(job._id), job.job_type || "video"]));
  let videoProcessing = 0;
  let portraitProcessing = 0;
  for (const row of processingItems) {
    if (typeByJob.get(String(row.job_id)) === "portrait") portraitProcessing += 1;
    else videoProcessing += 1;
  }
  const preferVideo = videoProcessing <= portraitProcessing;
  const order = preferVideo ? [orderedVideoJobs, portraitJobs] : [portraitJobs, orderedVideoJobs];
  for (const jobs of order) {
    const claimed = await claimFromJobs(jobs, renderReady);
    if (claimed) return claimed;
  }
  return null;
};

const finishBlocked = async (
  item: InstanceType<typeof VideoGenerationJobItem>,
  started: number,
  reason: string
) => {
  item.status = "BLOCKED";
  item.completed_at = new Date();
  item.duration_ms = Date.now() - started;
  item.error = reason.slice(0, 2000);
  item.failure_stage = "PORTRAIT_RESOLUTION";
  await item.save();
  await markNominationVideoBlocked(item.nomination_id, reason, item.job_id);
  await recordFinishedItem(
    item.job_id,
    {
      nomination_id: item.nomination_id,
      teacher_name: item.teacher_name,
      teacher_phone: item.teacher_phone,
      status: "BLOCKED",
      error: reason,
      failure_stage: "PORTRAIT_RESOLUTION",
    },
    null
  ).catch((err) => console.error("[video-worker] progress update failed", err));
};

const processPortraitItem = async (
  item: InstanceType<typeof VideoGenerationJobItem>,
  job: { mode?: unknown }
) => {
  const started = Date.now();
  const current: VideoJobCurrent = {
    nomination_id: item.nomination_id,
    teacher_name: item.teacher_name,
    teacher_phone: item.teacher_phone,
    category_id: item.category_id,
    category_icon_filename: null,
    stage: "GENERATING_IMAGE",
  };
  await VideoGenerationJob.findByIdAndUpdate(item.job_id, { $set: { current } });
  await recountJob(item.job_id);
  if ((await VideoGenerationJob.findById(item.job_id).lean())?.cancel_requested) return;

  try {
    const result = await generateFinalizedPortrait({
      phone: item.teacher_phone,
      regenerate: job.mode === "regenerate" || job.mode === "retry",
    });
    if (!result.ok) {
      item.status = result.needs_review ? "BLOCKED" : "FAILED";
      item.completed_at = new Date();
      item.duration_ms = Date.now() - started;
      item.error = (result.needs_review ? result.reason : result.error).slice(0, 2000);
      item.failure_stage = "GENERATING_IMAGE";
      await item.save();
      await recordFinishedItem(
        item.job_id,
        {
          nomination_id: item.nomination_id,
          teacher_name: item.teacher_name,
          teacher_phone: item.teacher_phone,
          status: item.status,
          error: item.error,
          failure_stage: "GENERATING_IMAGE",
        },
        null
      ).catch((err) => console.error("[video-worker] progress update failed", err));
      return;
    }
    item.status = "COMPLETED";
    item.completed_at = new Date();
    item.duration_ms = Date.now() - started;
    item.error = result.skipped ? `skipped:${result.reason}` : null;
    item.failure_stage = null;
    await item.save();
    await recordFinishedItem(
      item.job_id,
      {
        nomination_id: item.nomination_id,
        teacher_name: item.teacher_name,
        teacher_phone: item.teacher_phone,
        status: "COMPLETED",
        error: null,
        failure_stage: null,
      },
      Date.now() - started
    ).catch((err) => console.error("[video-worker] progress update failed", err));
  } catch (err) {
    const message = messageOf(err);
    item.status = "FAILED";
    item.completed_at = new Date();
    item.duration_ms = Date.now() - started;
    item.error = message;
    item.failure_stage = "GENERATING_IMAGE";
    await item.save();
    await recordFinishedItem(
      item.job_id,
      {
        nomination_id: item.nomination_id,
        teacher_name: item.teacher_name,
        teacher_phone: item.teacher_phone,
        status: "FAILED",
        error: message,
        failure_stage: "GENERATING_IMAGE",
      },
      null
    ).catch((progressErr) => console.error("[video-worker] progress update failed", progressErr));
  }
};

const processItem = async (item: InstanceType<typeof VideoGenerationJobItem>) => {
  const started = Date.now();
  const inflight = await VideoGenerationJobItem.exists({
    nomination_id: item.nomination_id,
    status: "PROCESSING",
    _id: { $ne: item._id },
  });
  if (inflight) {
    item.status = "CANCELLED";
    item.completed_at = new Date();
    item.duration_ms = Date.now() - started;
    item.error = "Skipped — same nomination already processing in another job";
    await item.save();
    await recountJob(item.job_id);
    return;
  }
  const current: VideoJobCurrent = {
    nomination_id: item.nomination_id,
    teacher_name: item.teacher_name,
    teacher_phone: item.teacher_phone,
    category_id: item.category_id,
    category_icon_filename: item.category_icon_filename || null,
    stage: "CLASSIFYING",
  };
  await VideoGenerationJob.findByIdAndUpdate(item.job_id, { $set: { current } });
  await recountJob(item.job_id);

  const job = await VideoGenerationJob.findById(item.job_id).lean();
  if (job?.cancel_requested) return;
  if ((job?.job_type || "video") === "portrait") {
    await processPortraitItem(item, job || {});
    await recountJob(item.job_id);
    return;
  }

  const regenerate = job?.mode === "regenerate" || job?.mode === "retry";
  const includePortraits = Boolean(job?.include_portraits) || job?.job_type === "image_plus_video";
  const forceWithoutPhoto = Boolean(job?.force_without_photo);

  const setStage = async (stage: VideoFailureStage) => {
    await VideoGenerationJob.findByIdAndUpdate(item.job_id, {
      $set: { current: { ...current, stage } },
    });
  };

  try {
    if (item.photo_used && !forceWithoutPhoto) {
      const gate = await ensureVerifiedProductionPortrait({
        phone: item.teacher_phone,
        generateIfMissing: includePortraits,
        onStage: setStage,
      });
      if (!gate.ok) {
        await finishBlocked(item, started, gate.blocked);
        await recountJob(item.job_id);
        return;
      }
    }

    const result = await generateNominationVideo({
      nominationId: item.nomination_id,
      jobId: item.job_id,
      regenerate,
      forceWithoutPhoto,
      onStage: setStage,
    });
    const duration = Date.now() - started;
    item.status = "COMPLETED";
    item.completed_at = new Date();
    item.duration_ms = duration;
    item.render_id = result.render_id;
    item.video_url = result.video_url;
    item.photo_used = result.photo_used;
    item.category_icon_id = result.category_icon_id;
    item.category_icon_filename = result.category_icon_filename;
    item.audio_filename = PRODUCTION_AUDIO_FILENAME;
    item.error = null;
    item.failure_stage = null;
    await item.save();

    await recordFinishedItem(
      item.job_id,
      {
        nomination_id: item.nomination_id,
        teacher_name: item.teacher_name,
        teacher_phone: item.teacher_phone,
        status: "COMPLETED",
        error: null,
        failure_stage: null,
      },
      duration
    ).catch((err) => console.error("[video-worker] progress update failed", err));
  } catch (err) {
    const message = messageOf(err);
    const stage = stageOf(err);
    const blocked =
      stage === "PORTRAIT_RESOLUTION" &&
      /portrait|unverified|phone is missing|not have a valid finalized/i.test(message);
    if (blocked) {
      await finishBlocked(
        item,
        started,
        message.startsWith("BLOCKED") ? message : `BLOCKED — ${message}`
      );
    } else {
      item.status = "FAILED";
      item.completed_at = new Date();
      item.duration_ms = Date.now() - started;
      item.error = message;
      item.failure_stage = stage;
      await item.save();
      await markNominationVideoFailed(item.nomination_id, `${stage}: ${message}`, item.job_id);
      await recordFinishedItem(
        item.job_id,
        {
          nomination_id: item.nomination_id,
          teacher_name: item.teacher_name,
          teacher_phone: item.teacher_phone,
          status: "FAILED",
          error: message,
          failure_stage: stage,
        },
        null
      ).catch((progressErr) => console.error("[video-worker] progress update failed", progressErr));
    }
  }

  await recountJob(item.job_id);
};

const workerLoop = async () => {
  while (true) {
    const claimed = await claimNextItem();
    if (!claimed) return;
    await processItem(claimed.item);
  }
};

/**
 * Renders need the bg-remove tree, Python and FFmpeg. The API also runs on
 * serverless, where none of that exists, so that instance must leave queued
 * items alone instead of claiming and failing every one of them.
 */
const RENDER_CHECK_TTL_MS = 60_000;
let renderCheckedAt = 0;
let renderCapable = false;

export const canRenderVideos = () => {
  if (Date.now() - renderCheckedAt < RENDER_CHECK_TTL_MS) return renderCapable;
  renderCheckedAt = Date.now();
  try {
    assertVideoRenderReady();
    renderCapable = true;
  } catch (err) {
    if (renderCapable !== false) {
      console.warn(`[video-worker] not rendering here: ${err instanceof Error ? err.message : err}`);
    }
    renderCapable = false;
  }
  return renderCapable;
};

export const kickVideoWorker = () => {
  if (pumping) return;
  pumping = true;
  void (async () => {
    let crashed = false;
    try {
      await requeueStaleItems();
      await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));
      const running = await VideoGenerationJob.find({ status: "running" }).select("_id").lean();
      for (const job of running) await recountJob(job._id);
    } catch (err) {
      crashed = true;
      console.error("[video-worker] pump failed", err);
    } finally {
      pumping = false;
      const leftover = await hasClaimableQueued().catch(() => false);
      const running = await VideoGenerationJob.exists({
        status: "running",
        cancel_requested: { $ne: true },
      }).catch(() => false);
      if (leftover && running) setTimeout(kickVideoWorker, crashed ? 15_000 : 0);
    }
  })();
};

const hasClaimableQueued = async () => {
  if (canRenderVideos()) {
    return Boolean(await VideoGenerationJobItem.exists({ status: "QUEUED" }));
  }
  const portraitJobs = await VideoGenerationJob.find({
    status: "running",
    cancel_requested: { $ne: true },
    job_type: "portrait",
  })
    .select("_id")
    .lean();
  if (!portraitJobs.length) return false;
  return Boolean(
    await VideoGenerationJobItem.exists({
      status: "QUEUED",
      job_id: { $in: portraitJobs.map((job) => job._id) },
    })
  );
};

export const startVideoGenerationWorker = async () => {
  if (!canRenderVideos()) {
    console.log("[video-worker] renderer unavailable on this instance; video encodes wait for a render host");
  }
  await requeueStaleItems();
  const running = await VideoGenerationJob.find({ status: "running" }).select("_id").lean();
  for (const job of running) await recountJob(job._id);
  kickVideoWorker();
  setInterval(() => {
    void requeueStaleItems()
      .then(() => kickVideoWorker())
      .catch(() => undefined);
  }, SWEEP_INTERVAL_MS).unref();
};

export const etaSecondsFor = (job: {
  queued?: number;
  processing?: number;
  completed?: number;
  avg_ms?: number;
  recent_durations_ms?: number[];
}) => {
  const remaining = Number(job.queued || 0) + Number(job.processing || 0);
  const samples = Array.isArray(job.recent_durations_ms) ? job.recent_durations_ms : [];
  const avg = Number(job.avg_ms || 0);
  if (remaining <= 0) return 0;
  if (Number(job.completed || 0) < 2 || samples.length < 2 || avg <= 0) return null;
  return Math.max(1, Math.round((remaining * avg) / CONCURRENCY / 1000));
};

export const jobPublicView = (job: Record<string, unknown>) => {
  const queued = Number(job.queued || 0);
  const processing = Number(job.processing || 0);
  const completed = Number(job.completed || 0);
  const failed = Number(job.failed || 0);
  const blocked = Number(job.blocked || 0);
  const cancelled = Number(job.cancelled || 0);
  const total = Number(job.total || 0);
  const done = completed + failed + cancelled + blocked;
  const eta = etaSecondsFor(job);
  return {
    job_id: String(job._id || job.id || ""),
    job_number: Number(job.job_number || 0),
    status: job.status,
    mode: job.mode,
    job_type: job.job_type || "video",
    include_portraits: Boolean(job.include_portraits),
    category_id: job.category_id,
    kind: job.kind,
    photo: job.photo,
    teacher_count: Number(job.teacher_count || 0),
    total,
    queued,
    processing,
    completed,
    failed,
    blocked,
    cancelled,
    progress_pct: total ? Math.round((done / total) * 100) : 0,
    avg_ms: Number(job.avg_ms || 0),
    eta_seconds: eta,
    current: job.current || null,
    recent: Array.isArray(job.recent) ? job.recent : [],
    verification: job.verification || null,
    cancel_requested: Boolean(job.cancel_requested),
    started_at: job.started_at || null,
    completed_at: job.completed_at || null,
    duration_ms:
      job.started_at && (job.completed_at || job.status === "running")
        ? Math.max(0, new Date(String(job.completed_at || new Date())).getTime() - new Date(String(job.started_at)).getTime())
        : null,
  };
};

export const activeLiveStatuses = async () => {
  const items = await VideoGenerationJobItem.find({ status: { $in: ["QUEUED", "PROCESSING"] } })
    .select("nomination_id status")
    .lean();
  const map = new Map<string, "QUEUED" | "PROCESSING">();
  for (const item of items) {
    map.set(item.nomination_id, item.status as "QUEUED" | "PROCESSING");
  }
  return map;
};

const verifyJobProduction = async (jobId: string) => {
  const job = await VideoGenerationJob.findById(jobId).lean();
  if (!job || job.job_type === "portrait") return;
  const items = await VideoGenerationJobItem.find({ job_id: jobId })
    .select("nomination_id status")
    .lean();
  const ids = items.map((row) => row.nomination_id);
  const [noms, videos] = await Promise.all([
    Nomination.find({ _id: { $in: ids } })
      .select("_id type student_class photo_url")
      .lean(), // Nomination collection only — AfterSessionNomination cannot appear here.
    NominationVideo.find({ nomination_id: { $in: ids } })
      .select("nomination_id generation_status video_url video_template nomination_kind photo_used video_category production_photo_fallback audio_filename")
      .lean(),
  ]);
  const nomById = new Map(noms.map((n) => [String(n._id), n]));
  const videoById = new Map(videos.map((v) => [String(v.nomination_id), v]));
  let valid = 0;
  let generated = 0;
  let skipped = 0;
  let remainingInvalid = 0;
  let remainingMissing = 0;
  for (const item of items) {
    const nom = nomById.get(item.nomination_id);
    if (!nom) continue;
    const video = videoById.get(item.nomination_id);
    const validity = videoProductionValidity({
      video,
      nominationId: item.nomination_id,
      expectedKind: nominationKind(nom),
      expectedPhoto: photoStateOf(nom.photo_url),
    });
    if (item.status === "COMPLETED") generated += 1;
    if (validity === "VALID") {
      valid += 1;
      if (item.status !== "COMPLETED") skipped += 1;
    } else if (validity === "INVALID") remainingInvalid += 1;
    else remainingMissing += 1;
  }
  await VideoGenerationJob.findByIdAndUpdate(jobId, {
    $set: {
      verification: {
        total: items.length,
        valid,
        generated,
        skipped,
        failed: Number(job.failed || 0),
        blocked: Number(job.blocked || 0),
        remaining_invalid: remainingInvalid,
        remaining_missing: remainingMissing,
        verified_at: new Date(),
      },
    },
  });
};
