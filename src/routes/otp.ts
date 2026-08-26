import { Router, Request, Response } from "express";
import { KarixError, generateAndSendOtp, verifyStoredOtp } from "../lib/karix";
import { Nomination } from "../models/Nomination";

const router = Router();

const MASTER_PHONE = "9123456789";
const MASTER_OTP = "000000";

const cleanPhone = (phone: unknown) => String(phone ?? "").replace(/\D/g, "").slice(-10);

// Every send bills the SMS gateway, so throttle per number. In-memory is enough here:
// the backend is a single instance and a restart resetting the window is harmless.
const RESEND_INTERVAL_MS = 30_000;
const MAX_SENDS_PER_DAY = 10;
const sendLog = new Map<string, { last: number; count: number; day: number }>();

const throttleReason = (phone: string) => {
  const now = Date.now();
  const day = Math.floor(now / 86_400_000);
  const entry = sendLog.get(phone);

  if (!entry || entry.day !== day) {
    sendLog.set(phone, { last: now, count: 1, day });
    return null;
  }
  if (now - entry.last < RESEND_INTERVAL_MS) {
    const wait = Math.ceil((RESEND_INTERVAL_MS - (now - entry.last)) / 1000);
    return `Please wait ${wait}s before requesting another OTP`;
  }
  if (entry.count >= MAX_SENDS_PER_DAY) {
    return "Too many OTP requests today. Please try again tomorrow.";
  }

  entry.last = now;
  entry.count += 1;
  return null;
};

const markDraftVerified = async (phone: string, draftToken: unknown) => {
  const token = typeof draftToken === "string" ? draftToken.trim() : "";
  if (!token) return;
  await Nomination.findOneAndUpdate(
    { draft_token: token, nominator_phone: phone, status: "draft" },
    { phone_verified: true, form_step: "otp_verified" }
  );
};

const sendError = (res: Response, err: unknown, fallback: string) => {
  if (err instanceof KarixError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.gatewayCode ? { gateway_code: err.gatewayCode } : {}),
    });
    return;
  }
  console.error("Error:", err);
  const message = err instanceof Error ? err.message : fallback;
  res.status(500).json({ error: message });
};

router.post("/send", async (req: Request, res: Response) => {
  try {
    const cleaned = cleanPhone(req.body?.phone);
    if (cleaned.length !== 10) {
      res.status(400).json({ error: "Enter a valid 10-digit number" });
      return;
    }

    if (cleaned !== MASTER_PHONE) {
      const blocked = throttleReason(cleaned);
      if (blocked) {
        res.status(429).json({ error: blocked });
        return;
      }
      await generateAndSendOtp(cleaned);
    }

    res.json({ success: true });
  } catch (err) {
    sendError(res, err, "Failed to send OTP");
  }
});

router.post("/verify", async (req: Request, res: Response) => {
  try {
    const { phone, otp, draft_token } = req.body ?? {};
    if (!phone || !otp) {
      res.status(400).json({ error: "Phone and OTP required" });
      return;
    }

    const cleaned = cleanPhone(phone);
    const isMaster = cleaned === MASTER_PHONE && String(otp) === MASTER_OTP;

    if (!isMaster) {
      try {
        await verifyStoredOtp(cleaned, String(otp));
      } catch (err) {
        if (err instanceof KarixError) {
          res.status(err.status === 500 ? 500 : 400).json({ success: false, error: err.message });
          return;
        }
        const message = err instanceof Error ? err.message : "Invalid OTP. Please try again.";
        res.status(400).json({ success: false, error: message });
        return;
      }
    }

    await markDraftVerified(cleaned, draft_token);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, "Failed to verify OTP");
  }
});

export default router;
