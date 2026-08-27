import { Schema, model } from "mongoose";

const otpSchema = new Schema(
  {
    phoneNumber: { type: String, required: true, unique: true },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpVerification = model("OtpVerification", otpSchema, "otp_verifications");
