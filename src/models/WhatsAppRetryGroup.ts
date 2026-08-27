import { Schema, model, Types } from "mongoose";

export const RETRY_GROUP_STATUSES = ["open", "closed_no_more_retries", "exhausted"] as const;
export type RetryGroupStatus = (typeof RETRY_GROUP_STATUSES)[number];

const whatsAppRetryGroupSchema = new Schema({
  messageKind: { type: String, required: true, trim: true, maxlength: 64, index: true },
  trigger: {
    type: String,
    enum: ["api", "retry_cron", "admin_manual"],
    default: "api",
    index: true,
  },
  attempt2BatchId: { type: Schema.Types.ObjectId, default: null },
  attempt2TriggeredAt: { type: Date, default: null },
  attempt3BatchId: { type: Schema.Types.ObjectId, default: null },
  attempt3TriggeredAt: { type: Date, default: null },
  attempt1CompletedAt: { type: Date, default: null },
  attempt2CompletedAt: { type: Date, default: null },
  nextPromotionDueAt: { type: Date, default: null, index: true },
  status: {
    type: String,
    enum: RETRY_GROUP_STATUSES,
    default: "open",
    index: true,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

whatsAppRetryGroupSchema.pre("save", function () {
  this.updatedAt = new Date();
});

whatsAppRetryGroupSchema.index({ createdAt: -1 });
whatsAppRetryGroupSchema.index({ status: 1, nextPromotionDueAt: 1 });

export type WhatsAppRetryGroupDoc = {
  _id: Types.ObjectId;
  messageKind: string;
  trigger: "api" | "retry_cron" | "admin_manual";
  attempt2BatchId: Types.ObjectId | null;
  attempt2TriggeredAt: Date | null;
  attempt3BatchId: Types.ObjectId | null;
  attempt3TriggeredAt: Date | null;
  attempt1CompletedAt: Date | null;
  attempt2CompletedAt: Date | null;
  nextPromotionDueAt: Date | null;
  status: RetryGroupStatus;
  createdAt: Date;
  updatedAt: Date;
};

export const WhatsAppRetryGroup = model("WhatsAppRetryGroup", whatsAppRetryGroupSchema);
