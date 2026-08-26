import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

export const FUNNEL_TRACK_STAGES = ["otp_requested", "otp_verified", "form_step1"] as const;
export type FunnelTrackStage = (typeof FUNNEL_TRACK_STAGES)[number];

const funnelEventSchema = new Schema({
  _id: { type: String, default: () => randomUUID() },
  created_at: { type: Date, default: Date.now },
  stage: { type: String, required: true, enum: FUNNEL_TRACK_STAGES },
  phone: { type: String, required: true },
    role: { type: String, enum: ["student", "teacher"], default: undefined },
});

funnelEventSchema.index({ stage: 1, phone: 1 }, { unique: true });
funnelEventSchema.index({ created_at: 1 });

export const FunnelEvent = model("FunnelEvent", funnelEventSchema);
