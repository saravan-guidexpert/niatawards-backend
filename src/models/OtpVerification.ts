import { Schema, model } from "mongoose";

const otpSchema = new Schema({
  phone: { type: String, required: true, unique: true },
  otp: { type: String, required: true },
  expires_at: { type: Date, required: true },
});

export const OtpVerification = model("OtpVerification", otpSchema, "otp_verifications");
