import { Schema, model, Types } from "mongoose";
import { RETRY_EXCLUSION_REASONS } from "../lib/whatsappRetryRules";

export const WHATSAPP_MESSAGE_STATUSES = [
  "queued",
  "submitted",
  "sent",
  "failed",
  "delivered",
  "read",
  "retry_exhausted",
] as const;
export type WhatsAppMessageStatus = (typeof WHATSAPP_MESSAGE_STATUSES)[number];

export const WHATSAPP_SEND_SOURCES = ["api", "retry_cron", "admin_manual"] as const;
export type WhatsAppSendSource = (typeof WHATSAPP_SEND_SOURCES)[number];

const whatsAppMessageEventSchema = new Schema({
  retryGroupId: {
    type: Schema.Types.ObjectId,
    ref: "WhatsAppRetryGroup",
    required: true,
    index: true,
  },
  attemptNumber: {
    type: Number,
    required: true,
    min: 1,
    max: 6,
    default: 1,
    index: true,
  },
  parentMessageEventId: {
    type: Schema.Types.ObjectId,
    ref: "WhatsAppMessageEvent",
    default: null,
    index: true,
  },
  attemptBatchId: { type: Schema.Types.ObjectId, default: null, index: true },
  retrySource: {
    type: String,
    enum: ["initial", "retry1", "retry2", "manual_recovery"],
    default: "initial",
  },
  terminalFailureKind: {
    type: String,
    enum: ["permanent", "transient"],
    default: null,
    index: true,
  },
  retryEligible: { type: Boolean, default: true, index: true },
  phone: { type: String, required: true, index: true, match: [/^\d{10}$/, "10-digit phone"] },
  messageKind: { type: String, required: true, trim: true, maxlength: 64, index: true },
  source: {
    type: String,
    required: true,
    enum: WHATSAPP_SEND_SOURCES,
  },
  templateIdEnvKey: { type: String, trim: true, maxlength: 64, default: null },
  templateId: { type: String, trim: true, maxlength: 128, default: null },
  params: { type: [String], default: [] },
  gupshupMessageId: { type: String, trim: true, maxlength: 256, default: null, index: true },
  gupshupInternalMessageId: { type: String, trim: true, maxlength: 256, default: null, index: true },
  whatsappWaMessageId: { type: String, trim: true, maxlength: 256, default: null, index: true },
  providerAcceptedAt: { type: Date, default: null },
  providerPayloadSnippet: { type: String, maxlength: 1200, default: null },
  status: {
    type: String,
    required: true,
    enum: WHATSAPP_MESSAGE_STATUSES,
    default: "queued",
    index: true,
  },
  errorMessage: { type: String, maxlength: 2000, default: null },
  webhookErrorCode: { type: String, trim: true, maxlength: 32, default: null },
  webhookErrorReason: { type: String, trim: true, maxlength: 2000, default: null },
  sendErrorCode: { type: String, trim: true, maxlength: 32, default: null },
  retryExclusionReason: {
    type: String,
    enum: RETRY_EXCLUSION_REASONS,
    default: null,
    index: true,
  },
  retryExclusionAt: { type: Date, default: null },
  retryExclusionMeta: {
    nextAttempt: { type: Number, min: 2, max: 6, default: null },
    attemptBatchId: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, trim: true, maxlength: 200, default: null },
  },
  headerImageUrl: { type: String, trim: true, maxlength: 1024, default: null },
  sentAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  readAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

whatsAppMessageEventSchema.pre("save", function () {
  this.updatedAt = new Date();
});

whatsAppMessageEventSchema.index({ createdAt: -1 });
whatsAppMessageEventSchema.index({ phone: 1, messageKind: 1, createdAt: -1 });
whatsAppMessageEventSchema.index({ messageKind: 1, attemptNumber: 1, retryEligible: 1, status: 1, createdAt: 1 });
whatsAppMessageEventSchema.index({ retryGroupId: 1, attemptNumber: 1 });
whatsAppMessageEventSchema.index(
  { retryGroupId: 1, phone: 1, attemptNumber: 1 },
  { unique: true, partialFilterExpression: { retryGroupId: { $exists: true, $type: "objectId" } } }
);

export type WhatsAppMessageEventDoc = {
  _id: Types.ObjectId;
  retryGroupId: Types.ObjectId;
  attemptNumber: number;
  parentMessageEventId: Types.ObjectId | null;
  attemptBatchId: Types.ObjectId | null;
  retrySource: "initial" | "retry1" | "retry2" | "manual_recovery";
  terminalFailureKind: "permanent" | "transient" | null;
  retryEligible: boolean;
  phone: string;
  messageKind: string;
  source: WhatsAppSendSource;
  templateIdEnvKey: string | null;
  templateId: string | null;
  params: string[];
  gupshupMessageId: string | null;
  gupshupInternalMessageId: string | null;
  whatsappWaMessageId: string | null;
  providerAcceptedAt: Date | null;
  providerPayloadSnippet: string | null;
  status: WhatsAppMessageStatus;
  errorMessage: string | null;
  webhookErrorCode: string | null;
  webhookErrorReason: string | null;
  sendErrorCode: string | null;
  retryExclusionReason: string | null;
  retryExclusionAt: Date | null;
  headerImageUrl: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export const WhatsAppMessageEvent = model("WhatsAppMessageEvent", whatsAppMessageEventSchema);
