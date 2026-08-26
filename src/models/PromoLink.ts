import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
};

export const PLATFORMS = [
  "instagram",
  "youtube",
  "whatsapp",
  "telegram",
  "linkedin",
  "facebook",
  "twitter",
  "other",
] as const;

export const DESTINATIONS = ["/", "/nominate-student", "/nominate-teacher"] as const;

export const slugifyInfluencer = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "influencer";

const promoLinkSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    influencer_name: { type: String, required: true },
    influencer_slug: { type: String, required: true },
    platform: { type: String, required: true, enum: PLATFORMS },
    campaign: { type: String, required: true },
    destination: { type: String, required: true, enum: DESTINATIONS },
    views: { type: Number, default: 0 },
    last_click_at: { type: Date, default: null },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

promoLinkSchema.index(
  { influencer_slug: 1, platform: 1, campaign: 1, destination: 1 },
  { unique: true }
);

export const PromoLink = model("PromoLink", promoLinkSchema);
