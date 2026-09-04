import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";
import { NOMINATION_FORM_STEPS } from "./Nomination";

/**
 * Future nomination / form submissions only.
 * Separate collection from production `nominations`.
 * Must never be read by portrait, video, messaging, or production workers.
 */
export const AFTER_SESSION_ADMIN_STATUSES = ["NEW", "VIEWED", "ARCHIVED"] as const;
export type AfterSessionAdminStatus = (typeof AFTER_SESSION_ADMIN_STATUSES)[number];

export const AFTER_SESSION_LIFECYCLES = ["draft", "submitted"] as const;
export type AfterSessionLifecycle = (typeof AFTER_SESSION_LIFECYCLES)[number];

export const AFTER_SESSION_SOURCE_FORMS = ["inline_draft", "one_shot_api"] as const;
export type AfterSessionSourceForm = (typeof AFTER_SESSION_SOURCE_FORMS)[number];

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  delete ret.draft_token;
  return ret;
};

const afterSessionNominationSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
    submitted_at: { type: Date, default: null },

    lifecycle: {
      type: String,
      enum: AFTER_SESSION_LIFECYCLES,
      default: "draft",
      required: true,
    },
    admin_status: {
      type: String,
      enum: AFTER_SESSION_ADMIN_STATUSES,
      default: "NEW",
      required: true,
    },
    source_form: { type: String, required: true, default: "inline_draft" },

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
    email: { type: String, default: null },
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
    extra_fields: { type: Schema.Types.Mixed, default: {} },
    raw_payload: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "after_session_nominations",
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

afterSessionNominationSchema.index({ created_at: -1 });
afterSessionNominationSchema.index({ submitted_at: -1 });
afterSessionNominationSchema.index({ phone: 1 });
afterSessionNominationSchema.index({ nominator_phone: 1 });
afterSessionNominationSchema.index({ type: 1 });
afterSessionNominationSchema.index({ source_form: 1 });
afterSessionNominationSchema.index({ lifecycle: 1, admin_status: 1, created_at: -1 });
afterSessionNominationSchema.index({ nominator_phone: 1, type: 1, lifecycle: 1 });
afterSessionNominationSchema.index({ draft_token: 1 }, { sparse: true });

afterSessionNominationSchema.pre("save", function () {
  (this as { updated_at?: Date }).updated_at = new Date();
});

export const AfterSessionNomination = model("AfterSessionNomination", afterSessionNominationSchema);
