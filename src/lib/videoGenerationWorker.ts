import {
  VideoGenerationJob,
  VideoGenerationJobItem,
  type VideoFailureStage,
  type VideoJobCurrent,
  type VideoJobMode,
  type VideoJobRecentItem,
} from "../models/VideoGenerationJob";
import { PRODUCTION_AUDIO_FILENAME } from "../models/NominationVideo";
import {
  generateNominationVideo,
  isSuccessfulFinalVideo,
  markNominationVideoFailed,
  VideoPipelineError,
} from "./generateNominationVideo";
import { isFinalizedPortrait } from "./nominationKind";
import type { CategoryTeacher, CatalogPortrait, CatalogVideo } from "./teacherPortraitCatalog";

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
}): {
  queued: PlannedVideo[];
  teacher_count: number;
  eligible_nominations: number;
  already_generated: number;
  blocked_missing_portrait: number;
} => {
  const queued: PlannedVideo[] = [];
  let eligible = 0;
  let already = 0;
  let blocked = 0;
  const selectedPhones = new Set(opts.teachers.map((t) => t.phone));

  for (const teacher of opts.teachers) {
    const portrait = opts.portraits.get(teacher.phone);
    const imageReady = teacher.photo === "without_photo" || isFinalizedPortrait(portrait);
    for (const nominationId of teacher.nomination_ids) {
      eligible += 1;
      const existing = opts.videos.get(nominationId);
      if (!opts.regenerate && isSuccessfulFinalVideo(existing)) {
        already += 1;
        continue;
      }
      if (!imageReady) {
        blocked += 1;
        continue;
      }
      queued.push({
        nomination_id: nominationId,
        teacher_phone: teacher.phone,
        teacher_name: teacher.name,
        category_id: teacher.category_id,
        photo_used: teacher.photo === "with_photo",
      });
    }
  }

  return {
    queued,
    teacher_count: selectedPhones.size,
    eligible_nominations: eligible,
    already_generated: already,
    blocked_missing_portrait: blocked,
  };
};

const nextJobNumber = async () => {
  const last = await VideoGenerationJob.findOne().sort({ job_number: -1 }).select("job_number").lean();
  return Math.max(1001, Number(last?.job_number || 1000) + 1);
};

const recountJob = async (jobId: string) => {
  const [queued, processing, completed, failed, cancelled] = await Promise.all([
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "QUEUED" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "PROCESSING" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "COMPLETED" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "FAILED" }),
    VideoGenerationJobItem.countDocuments({ job_id: jobId, status: "CANCELLED" }),
  ]);
  const job = await VideoGenerationJob.findById(jobId);
  if (!job) return null;
  job.queued = queued;
  job.processing = processing;
  job.completed = completed;
  job.failed = failed;
  job.cancelled = cancelled;
  const remaining = queued + processing;
  if (job.cancel_requested && remaining === 0) {
    job.status = "cancelled";
    job.completed_at = job.completed_at || new Date();
    job.current = null;
  } else if (!job.cancel_requested && remaining === 0 && job.total > 0) {
    job.status = "completed";
    job.completed_at = job.completed_at || new Date();
    job.current = null;
  }
  await job.save();
  return job;
};

const pushRecent = (job: { recent?: VideoJobRecentItem[] }, row: VideoJobRecentItem) => {
  const next = [row, ...(Array.isArray(job.recent) ? job.recent : [])].slice(0, RECENT_LIMIT);
  job.recent = next;
};

export const createVideoGenerationJob = async (opts: {
  mode: VideoJobMode;
  category_id: string;
  kind: string;
  photo: string;
  planned: PlannedVideo[];
  created_by?: string | null;
}) => {
  if (!opts.planned.length) {
    throw new Error("No nomination videos to queue");
  }
  const job = await VideoGenerationJob.create({
    job_number: await nextJobNumber(),
    status: "running",
    mode: opts.mode,
    category_id: opts.category_id,
    kind: opts.kind,
    photo: opts.photo,
    teacher_count: new Set(opts.planned.map((row) => row.teacher_phone)).size,
    total: opts.planned.length,
    queued: opts.planned.length,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    avg_ms: 0,
    recent_durations_ms: [],
    current: null,
    recent: [],
    cancel_requested: false,
    created_by: opts.created_by || null,
    started_at: new Date(),
  });
  await VideoGenerationJobItem.insertMany(
    opts.planned.map((row) => ({
      job_id: job._id,
      nomination_id: row.nomination_id,
      teacher_name: row.teacher_name,
      teacher_phone: row.teacher_phone,
      category_id: row.category_id,
      photo_used: row.photo_used,
      status: "QUEUED" as const,
      audio_filename: PRODUCTION_AUDIO_FILENAME,
    }))
  );
  kickVideoWorker();
  return job;
};

export const cancelQueuedVideoJob = async (jobId: string) => {
  const job = await VideoGenerationJob.findById(jobId);
  if (!job) return null;
  job.cancel_requested = true;
  await job.save();
  await VideoGenerationJobItem.updateMany(
    { job_id: jobId, status: "QUEUED" },
    { $set: { status: "CANCELLED", completed_at: new Date(), error: "Cancelled before start" } }
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
    planned: failed.map((row) => ({
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

const requeueStaleItems = async () => {
  const result = await VideoGenerationJobItem.updateMany(
    { status: "PROCESSING", started_at: { $lt: new Date(Date.now() - STALE_ITEM_MS) } },
    { $set: { status: "QUEUED", started_at: null, error: "Requeued after a stalled render" } }
  );
  return Number(result?.modifiedCount || 0);
};

const claimNextItem = async () => {
  const running = await VideoGenerationJob.find({ status: "running", cancel_requested: { $ne: true } })
    .sort({ started_at: 1 })
    .select("_id")
    .lean();
  for (const job of running) {
    const item = await VideoGenerationJobItem.findOneAndUpdate(
      { job_id: job._id, status: "QUEUED" },
      { $set: { status: "PROCESSING", started_at: new Date(), error: null, failure_stage: null } },
      { new: true, sort: { created_at: 1 } }
    );
    if (item) return item;
  }
  return null;
};

const processItem = async (item: InstanceType<typeof VideoGenerationJobItem>) => {
  const started = Date.now();
  const current: VideoJobCurrent = {
    nomination_id: item.nomination_id,
    teacher_name: item.teacher_name,
    teacher_phone: item.teacher_phone,
    category_id: item.category_id,
    category_icon_filename: item.category_icon_filename || null,
  };
  await VideoGenerationJob.findByIdAndUpdate(item.job_id, { $set: { current } });
  await recountJob(item.job_id);

  const job = await VideoGenerationJob.findById(item.job_id).lean();
  const regenerate = job?.mode === "regenerate" || job?.mode === "retry";

  try {
    const result = await generateNominationVideo({
      nominationId: item.nomination_id,
      jobId: item.job_id,
      regenerate,
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

    const fresh = await VideoGenerationJob.findById(item.job_id);
    if (fresh) {
      const rolling = [...(fresh.recent_durations_ms || []), duration].slice(-ROLLING);
      fresh.recent_durations_ms = rolling;
      fresh.avg_ms = Math.round(rolling.reduce((sum, n) => sum + n, 0) / rolling.length);
      pushRecent(fresh, {
        nomination_id: item.nomination_id,
        teacher_name: item.teacher_name,
        teacher_phone: item.teacher_phone,
        status: "COMPLETED",
        error: null,
        failure_stage: null,
      });
      await fresh.save();
    }
  } catch (err) {
    const message = messageOf(err);
    const stage = stageOf(err);
    item.status = "FAILED";
    item.completed_at = new Date();
    item.duration_ms = Date.now() - started;
    item.error = message;
    item.failure_stage = stage;
    await item.save();
    await markNominationVideoFailed(item.nomination_id, `${stage}: ${message}`, item.job_id);
    const fresh = await VideoGenerationJob.findById(item.job_id);
    if (fresh) {
      pushRecent(fresh, {
        nomination_id: item.nomination_id,
        teacher_name: item.teacher_name,
        teacher_phone: item.teacher_phone,
        status: "FAILED",
        error: message,
        failure_stage: stage,
      });
      await fresh.save();
    }
  }

  await recountJob(item.job_id);
};

const workerLoop = async () => {
  while (true) {
    const item = await claimNextItem();
    if (!item) return;
    await processItem(item);
  }
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
      const leftover = await VideoGenerationJobItem.exists({ status: "QUEUED" }).catch(() => false);
      const running = await VideoGenerationJob.exists({
        status: "running",
        cancel_requested: { $ne: true },
      }).catch(() => false);
      // Back off after a crash so a persistent DB fault cannot spin the pump.
      if (leftover && running) setTimeout(kickVideoWorker, crashed ? 15_000 : 0);
    }
  })();
};

export const startVideoGenerationWorker = async () => {
  await VideoGenerationJobItem.updateMany(
    { status: "PROCESSING" },
    { $set: { status: "QUEUED", started_at: null, error: "Recovered after restart" } }
  );
  const running = await VideoGenerationJob.find({ status: "running" }).select("_id").lean();
  for (const job of running) await recountJob(job._id);
  kickVideoWorker();
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
  const cancelled = Number(job.cancelled || 0);
  const total = Number(job.total || 0);
  const done = completed + failed + cancelled;
  const eta = etaSecondsFor(job);
  return {
    job_id: String(job._id || job.id || ""),
    job_number: Number(job.job_number || 0),
    status: job.status,
    mode: job.mode,
    category_id: job.category_id,
    kind: job.kind,
    photo: job.photo,
    teacher_count: Number(job.teacher_count || 0),
    total,
    queued,
    processing,
    completed,
    failed,
    cancelled,
    progress_pct: total ? Math.round((done / total) * 100) : 0,
    avg_ms: Number(job.avg_ms || 0),
    eta_seconds: eta,
    current: job.current || null,
    recent: Array.isArray(job.recent) ? job.recent : [],
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
