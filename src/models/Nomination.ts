import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

export const NOMINATION_FORM_STEPS = [
  "identity",
  "otp_sent",
  "otp_verified",
  "details",
  "submitted",
] as const;

export type NominationFormStep = (typeof NOMINATION_FORM_STEPS)[number];

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  delete ret.draft_token;
  return ret;
};

const nominationSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    type: { type: String, required: true, enum: ["student", "teacher"] },
    student_name: { type: String, default: null },
    student_class: { type: String, default: null },
    class_group: { type: String, default: null },
    school_name: { type: String, default: null },
    phone: { type: String, required: true },
    teacher_name: { type: String, default: null },
    award_category: { type: String, required: true, default: "General Nomination" },
    special_thing: { type: String, default: null },
    subject: { type: String, default: null },
    impact_story: { type: String, default: null },
    board: { type: String, default: null },
    teacher_social: { type: String, default: null },
    care_rating: { type: Number, default: null },
    clarity_rating: { type: Number, default: null },
    motivation_rating: { type: Number, default: null },
    support_rating: { type: Number, default: null },
    full_name: { type: String, default: null },
    experience: { type: String, default: null },
    photo_url: { type: String, default: null },
    utm_source: { type: String, default: null },
    utm_medium: { type: String, default: null },
    utm_campaign: { type: String, default: null },
    utm_term: { type: String, default: null },
    utm_content: { type: String, default: null },
    nominator_name: { type: String, default: null },
    nominator_phone: { type: String, default: null },
    phone_verified: { type: Boolean, default: false },
    form_step: {
      type: String,
      enum: NOMINATION_FORM_STEPS,
      default: "identity",
    },
    draft_token: { type: String, default: null },
    status: {
      type: String,
      required: true,
      enum: ["draft", "pending", "shortlisted", "winner", "rejected"],
      default: "pending",
    },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

nominationSchema.index({ status: 1 });
nominationSchema.index({ award_category: 1 });
nominationSchema.index({ nominator_phone: 1, type: 1, status: 1 });
nominationSchema.index({ draft_token: 1 }, { sparse: true });

export const Nomination = model("Nomination", nominationSchema);
