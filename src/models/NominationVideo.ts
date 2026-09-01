import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

export const VIDEO_GENERATION_STATUSES = ["pending", "generated", "failed"] as const;
export const VIDEO_REVIEW_STATUSES = [
  "none",
  "ready_for_review",
  "approved",
  "rejected",
  "regeneration_required",
] as const;

export type VideoGenerationStatus = (typeof VIDEO_GENERATION_STATUSES)[number];
export type VideoReviewStatus = (typeof VIDEO_REVIEW_STATUSES)[number];

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
};

// One record per student nomination (Nomination._id). Created by the future
// renderer when an MP4 exists. Admin review never creates a fake video_url.
const nominationVideoSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    nomination_id: { type: String, required: true, unique: true },
    generation_status: {
      type: String,
      required: true,
      enum: VIDEO_GENERATION_STATUSES,
      default: "pending",
    },
    review_status: {
      type: String,
      required: true,
      enum: VIDEO_REVIEW_STATUSES,
      default: "none",
    },
    video_url: { type: String, default: null },
    generated_at: { type: Date, default: null },
    approved_at: { type: Date, default: null },
    rejected_at: { type: Date, default: null },
    rejection_reason: { type: String, default: null },
    reviewed_by: { type: String, default: null },
    // True after admin approval. Does not mean sent. No message queue.
    ready_for_message: { type: Boolean, default: false },
    generation_error: { type: String, default: null },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

nominationVideoSchema.index({ review_status: 1 });
nominationVideoSchema.index({ generation_status: 1 });

export const NominationVideo = model("NominationVideo", nominationVideoSchema);
