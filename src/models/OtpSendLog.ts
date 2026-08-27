import { Schema, model } from "mongoose";

const WINDOW_SECONDS = 15 * 60;

const otpSendLogSchema = new Schema({
  phoneNumber: { type: String, required: true, index: true },
  sentAt: { type: Date, default: Date.now },
});

otpSendLogSchema.index({ sentAt: 1 }, { expireAfterSeconds: WINDOW_SECONDS });
otpSendLogSchema.index({ phoneNumber: 1, sentAt: -1 });

export const OtpSendLog = model("OtpSendLog", otpSendLogSchema, "otp_send_logs");
