import { Schema, model } from "mongoose";

// One row per outbound SMS, created when the gateway accepts the request and
// updated when its delivery report arrives. Karix accepts almost anything —
// unregistered senders included — so acceptance alone says nothing about
// delivery, and the DLR is the only place a scrub or failure is visible.
const smsMessageSchema = new Schema({
  request_id: { type: String, index: true },
  phone: { type: String, required: true },
  sender: { type: String },
  purpose: { type: String, default: "otp" },
  status: {
    type: String,
    enum: ["accepted", "delivered", "failed", "unknown"],
    default: "accepted",
  },
  // Verbatim status text from the gateway, since the code set is undocumented.
  gateway_status: { type: String },
  dlr_payload: { type: Schema.Types.Mixed },
  dlr_received_at: { type: Date },
  sent_at: { type: Date, default: Date.now },
});

smsMessageSchema.index({ sent_at: -1 });
// Delivery history is only useful for recent debugging; expire it after 60 days
// so the collection cannot grow without bound.
smsMessageSchema.index({ sent_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60 });

export const SmsMessage = model("SmsMessage", smsMessageSchema, "sms_messages");
