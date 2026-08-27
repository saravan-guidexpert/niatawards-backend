import { Schema, model, Types } from "mongoose";

const whatsAppWebhookEventSchema = new Schema({
  type: {
    type: String,
    required: true,
    enum: ["message", "message-event", "unknown"],
    index: true,
  },
  webhookDedupeKey: { type: String, required: true, unique: true, maxlength: 256 },
  gsId: { type: String, trim: true, maxlength: 256, default: null, index: true },
  providerId: { type: String, trim: true, maxlength: 256, default: null, index: true },
  eventStage: { type: String, trim: true, maxlength: 64, default: null },
  destination: { type: String, trim: true, maxlength: 20, default: null, index: true },
  sourcePhone: { type: String, trim: true, maxlength: 20, default: null, index: true },
  inboundText: { type: String, trim: true, maxlength: 4096, default: null },
  matchedMessageEventId: { type: Schema.Types.ObjectId, ref: "WhatsAppMessageEvent", default: null },
  payloadSnippet: { type: String, maxlength: 2000, default: null },
  processed: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

whatsAppWebhookEventSchema.index({ createdAt: -1 });

export type WhatsAppWebhookEventDoc = {
  _id: Types.ObjectId;
  type: "message" | "message-event" | "unknown";
  webhookDedupeKey: string;
  gsId: string | null;
  providerId: string | null;
  eventStage: string | null;
  destination: string | null;
  sourcePhone: string | null;
  inboundText: string | null;
  matchedMessageEventId: Types.ObjectId | null;
  payloadSnippet: string | null;
  processed: boolean;
  createdAt: Date;
};

export const WhatsAppWebhookEvent = model("WhatsAppWebhookEvent", whatsAppWebhookEventSchema);
