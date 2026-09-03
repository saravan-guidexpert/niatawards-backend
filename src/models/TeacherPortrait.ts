import { Schema, model } from "mongoose";

export const TEACHER_PORTRAIT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "GENERATED",
  "FAILED",
  "NEEDS_REVIEW",
  "NOT_PROVIDED",
] as const;

export type TeacherPortraitStatus = (typeof TEACHER_PORTRAIT_STATUSES)[number];

const teacherPortraitSchema = new Schema(
  {
    teacher_phone: { type: String, required: true, unique: true },
    teacher_name: { type: String, default: null },
    source_nomination_id: { type: String, default: null },
    source_photo_url: { type: String, default: null },
    source_photo_hash: { type: String, default: null },
    portrait_cloudinary_url: { type: String, default: null },
    cropped_cloudinary_url: { type: String, default: null },
    cropped_local_png_path: { type: String, default: null },
    portrait_status: {
      type: String,
      required: true,
      enum: TEACHER_PORTRAIT_STATUSES,
      default: "PENDING",
    },
    portrait_error: { type: String, default: null },
    local_png_path: { type: String, default: null },
    crop_version: { type: String, default: null },
    generated_at: { type: Date, default: null },
    finalized_at: { type: Date, default: null },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

teacherPortraitSchema.index({ portrait_status: 1 });

export const TeacherPortrait = model("TeacherPortrait", teacherPortraitSchema);
