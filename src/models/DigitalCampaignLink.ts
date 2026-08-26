import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";
import {
  DIGITAL_CHANNELS,
  DIGITAL_CREATIVE_TYPES,
  DIGITAL_DESTINATIONS,
  DIGITAL_LANGUAGES,
  DIGITAL_MEDIUMS,
  DIGITAL_STANDARD,
  DIGITAL_STATES,
} from "../lib/digitalCampaign";

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
};

const digitalCampaignLinkSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    standard: { type: String, required: true, default: DIGITAL_STANDARD },
    channel: { type: String, required: true, enum: DIGITAL_CHANNELS },
    state: { type: String, required: true, enum: DIGITAL_STATES },
    language: { type: String, required: true, enum: DIGITAL_LANGUAGES },
    audience: { type: String, default: "" },
    landing_diff: { type: String, default: "" },
    creative_type: { type: String, required: true, enum: DIGITAL_CREATIVE_TYPES },
    creative: { type: String, default: "" },
    ad_format: { type: String, default: "" },
    utm_source: { type: String, required: true },
    utm_medium: { type: String, required: true, enum: DIGITAL_MEDIUMS },
    utm_campaign: { type: String, required: true },
    destination: { type: String, required: true, enum: DIGITAL_DESTINATIONS },
    views: { type: Number, default: 0 },
    last_click_at: { type: Date, default: null },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

digitalCampaignLinkSchema.index(
  { utm_source: 1, utm_medium: 1, utm_campaign: 1, destination: 1 },
  { unique: true }
);

export const DigitalCampaignLink = model("DigitalCampaignLink", digitalCampaignLinkSchema);
