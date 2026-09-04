import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

export const VIDEO_JOB_STATUSES = ["running", "completed", "cancelled"] as const;
export const VIDEO_JOB_MODES = ["generate", "regenerate", "retry"] as const;
export const VIDEO_JOB_TYPES = ["video", "portrait", "image_plus_video"] as const;
export const VIDEO_JOB_ITEM_STATUSES = ["QUEUED", "PROCESSING", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"] as const;
export const VIDEO_FAILURE_STAGES = [
  "CLASSIFYING",
  "GENERATING_IMAGE",
  "CROPPING_IMAGE",
  "UPLOADING_IMAGE",
  "PORTRAIT_RESOLUTION",
  "VIDEO_RENDER",
  "AUDIO",
  "CLOUDINARY_UPLOAD",
  "DATABASE",
] as const;

export type VideoJobStatus = (typeof VIDEO_JOB_STATUSES)[number];
export type VideoJobMode = (typeof VIDEO_JOB_MODES)[number];
export type VideoJobType = (typeof VIDEO_JOB_TYPES)[number];
export type VideoJobItemStatus = (typeof VIDEO_JOB_ITEM_STATUSES)[number];
export type VideoFailureStage = (typeof VIDEO_FAILURE_STAGES)[number];

export type VideoJobCurrent = {
  nomination_id: string;
  teacher_name: string;
  teacher_phone: string;
  category_id: string;
  category_icon_filename: string | null;
  stage?: VideoFailureStage | null;
};

export type VideoJobRecentItem = {
  nomination_id: string;
  teacher_name: string;
  teacher_phone: string;
  status: VideoJobItemStatus;
  error: string | null;
  failure_stage: VideoFailureStage | null;
};

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
};

const videoGenerationJobSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    job_number: { type: Number, required: true, unique: true },
    status: { type: String, required: true, enum: VIDEO_JOB_STATUSES, default: "running" },
    mode: { type: String, required: true, enum: VIDEO_JOB_MODES, default: "generate" },
    job_type: { type: String, enum: VIDEO_JOB_TYPES, default: "video" },
    include_portraits: { type: Boolean, default: false },
    force_without_photo: { type: Boolean, default: false },
    category_id: { type: String, default: null },
    kind: { type: String, default: null },
    photo: { type: String, default: null },
    teacher_count: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    queued: { type: Number, default: 0 },
    processing: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    blocked: { type: Number, default: 0 },
    cancelled: { type: Number, default: 0 },
    avg_ms: { type: Number, default: 0 },
    recent_durations_ms: { type: [Number], default: [] },
    current: { type: Schema.Types.Mixed, default: null },
    recent: { type: [Schema.Types.Mixed], default: [] },
    verification: { type: Schema.Types.Mixed, default: null },
    cancel_requested: { type: Boolean, default: false },
    created_by: { type: String, default: null },
    started_at: { type: Date, default: Date.now },
    completed_at: { type: Date, default: null },
    created_at: { type: Date, default: Date.now },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

videoGenerationJobSchema.index({ created_at: -1 });
videoGenerationJobSchema.index({ status: 1, created_at: -1 });

const videoGenerationJobItemSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    job_id: { type: String, required: true, index: true },
    nomination_id: { type: String, required: true },
    teacher_name: { type: String, default: "" },
    teacher_phone: { type: String, default: "" },
    category_id: { type: String, default: "" },
    photo_used: { type: Boolean, default: false },
    status: { type: String, required: true, enum: VIDEO_JOB_ITEM_STATUSES, default: "QUEUED" },
    failure_stage: { type: String, default: null, enum: [...VIDEO_FAILURE_STAGES, null] },
    error: { type: String, default: null },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    duration_ms: { type: Number, default: null },
    render_id: { type: String, default: null },
    video_url: { type: String, default: null },
    category_icon_id: { type: String, default: null },
    category_icon_filename: { type: String, default: null },
    audio_filename: { type: String, default: null },
    created_at: { type: Date, default: Date.now },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

videoGenerationJobItemSchema.index({ job_id: 1, status: 1 });
videoGenerationJobItemSchema.index({ nomination_id: 1, created_at: -1 });
videoGenerationJobItemSchema.index({ status: 1 });

export const VideoGenerationJob = model("VideoGenerationJob", videoGenerationJobSchema);
export const VideoGenerationJobItem = model("VideoGenerationJobItem", videoGenerationJobItemSchema);
