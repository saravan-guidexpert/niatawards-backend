import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { OtpSendLog } from "../models/OtpSendLog";
import { OtpVerification } from "../models/OtpVerification";
import { maskPhone, sendMsg91Otp } from "./msg91";

export class OtpError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "OtpError";
    this.status = status;
  }
}

const RESEND_INTERVAL_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 3;
const SEND_WINDOW_MS = 15 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 3;
const LOAD_RETRIES = 3;
const LOAD_RETRY_MS = 150;

export const cleanPhone = (phone: unknown) => String(phone ?? "").replace(/\D/g, "").slice(-10);

export const isValidPhone = (phone: string) => /^\d{10}$/.test(phone);

export const isValidOtp = (otp: string) => /^\d{6}$/.test(otp);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const otpSecret = () => {
  const secret = process.env.OTP_SECRET?.trim();
  if (!secret) throw new OtpError("OTP is not configured", 500);
  return secret;
};

export const hashOtp = (otp: string) => createHmac("sha256", otpSecret()).update(otp).digest("hex");

const hashesMatch = (stored: string, computed: string) => {
  try {
    const a = Buffer.from(stored, "hex");
    const b = Buffer.from(computed, "hex");
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

const expiryMinutes = () => {
  const n = Number(process.env.OTP_EXPIRY_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 10;
};

const devConsoleOtp = () =>
  process.env.NODE_ENV !== "production" && process.env.OTP_DEV_CONSOLE === "true";

const bypassPhones = () =>
  (process.env.OTP_BYPASS_PHONES ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, "").slice(-10))
    .filter((s) => /^\d{10}$/.test(s));

const bypassCode = () => process.env.OTP_BYPASS_CODE?.trim() ?? "";

export const isBypassPhone = (phone: string) => {
  const code = bypassCode();
  return Boolean(code) && bypassPhones().includes(phone);
};

export const assertRateLimit = async (phone: string) => {
  const since = new Date(Date.now() - SEND_WINDOW_MS);
  const logs = await OtpSendLog.find({ phoneNumber: phone, sentAt: { $gte: since } })
    .sort({ sentAt: -1 })
    .lean();

  if (logs[0]) {
    const waitMs = RESEND_INTERVAL_MS - (Date.now() - new Date(logs[0].sentAt).getTime());
    if (waitMs > 0) {
      const wait = Math.ceil(waitMs / 1000);
      throw new OtpError(`Please wait ${wait}s before requesting another OTP`, 429);
    }
  }

  if (logs.length >= MAX_SENDS_PER_WINDOW) {
    throw new OtpError("Too many OTP requests. Please try again later.", 429);
  }
};

const persistOtp = async (phone: string, otp: string) => {
  const expiresAt = new Date(Date.now() + expiryMinutes() * 60 * 1000);
  await OtpVerification.deleteMany({ phoneNumber: phone });
  await OtpVerification.create({
    phoneNumber: phone,
    otpHash: hashOtp(otp),
    expiresAt,
    attempts: 0,
  });
};

const recordSend = async (phone: string) => {
  await OtpSendLog.create({ phoneNumber: phone, sentAt: new Date() });
};

export const generateAndSendOtp = async (phone: string) => {
  if (!isValidPhone(phone)) {
    throw new OtpError("Enter a valid 10-digit number", 400);
  }

  if (isBypassPhone(phone)) {
    await persistOtp(phone, bypassCode());
    if (devConsoleOtp()) {
      console.log(`[dev OTP] ${maskPhone(phone)} bypass (valid ${expiryMinutes()} min)`);
    }
    return;
  }

  await assertRateLimit(phone);

  const otp = String(randomInt(100000, 1000000));
  await sendMsg91Otp(phone, otp);
  await persistOtp(phone, otp);
  try {
    await recordSend(phone);
  } catch (err) {
    console.warn("Could not record OTP send log:", err instanceof Error ? err.message : err);
  }

  if (devConsoleOtp()) {
    console.log(`[dev OTP] ${maskPhone(phone)} -> ${otp} (valid ${expiryMinutes()} min)`);
  }
};

const loadLatestOtp = async (phone: string) => {
  for (let i = 0; i < LOAD_RETRIES; i += 1) {
    const row = await OtpVerification.findOne({ phoneNumber: phone }).sort({ createdAt: -1 });
    if (row) return row;
    if (i < LOAD_RETRIES - 1) await sleep(LOAD_RETRY_MS);
  }
  return null;
};

export const verifyStoredOtp = async (phone: string, otp: string) => {
  if (!isValidPhone(phone)) {
    throw new OtpError("Enter a valid 10-digit number", 400);
  }
  if (!isValidOtp(otp)) {
    throw new OtpError("Enter a valid 6-digit OTP", 400);
  }

  const row = await loadLatestOtp(phone);
  if (!row) {
    throw new OtpError("Invalid OTP. Please try again.", 400);
  }
  if (row.expiresAt.getTime() < Date.now()) {
    await OtpVerification.deleteOne({ _id: row._id });
    throw new OtpError("OTP expired. Please request a new one.", 400);
  }
  if ((row.attempts ?? 0) >= MAX_VERIFY_ATTEMPTS) {
    await OtpVerification.deleteOne({ _id: row._id });
    throw new OtpError("Too many attempts. Please request a new OTP.", 400);
  }

  if (!hashesMatch(row.otpHash, hashOtp(otp))) {
    const attempts = (row.attempts ?? 0) + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await OtpVerification.deleteOne({ _id: row._id });
    } else {
      await OtpVerification.updateOne({ _id: row._id }, { attempts });
    }
    throw new OtpError("Invalid OTP. Please try again.", 400);
  }

  await OtpVerification.deleteOne({ _id: row._id });
};
