import { Router, Request, Response } from "express";
import { Msg91Error } from "../lib/msg91";
import { OtpError, cleanPhone, generateAndSendOtp, isValidOtp, isValidPhone, verifyStoredOtp } from "../lib/otp";
import { Nomination } from "../models/Nomination";

const router = Router();

const markDraftVerified = async (phone: string, draftToken: unknown) => {
  const token = typeof draftToken === "string" ? draftToken.trim() : "";
  if (!token) return;
  await Nomination.findOneAndUpdate(
    { draft_token: token, nominator_phone: phone, status: "draft" },
    { phone_verified: true, form_step: "otp_verified" }
  );
};

const sendError = (res: Response, err: unknown, fallback: string) => {
  if (err instanceof OtpError || err instanceof Msg91Error) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("Error:", err);
  const message = err instanceof Error ? err.message : fallback;
  res.status(500).json({ error: message });
};

router.post("/send", async (req: Request, res: Response) => {
  try {
    const cleaned = cleanPhone(req.body?.phone);
    if (!isValidPhone(cleaned)) {
      res.status(400).json({ error: "Enter a valid 10-digit number" });
      return;
    }

    await generateAndSendOtp(cleaned);
    res.json({ success: true, message: "OTP sent successfully" });
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
    if (!isValidPhone(cleaned)) {
      res.status(400).json({ error: "Enter a valid 10-digit number" });
      return;
    }
    if (!isValidOtp(String(otp))) {
      res.status(400).json({ success: false, error: "Enter a valid 6-digit OTP" });
      return;
    }

    try {
      await verifyStoredOtp(cleaned, String(otp));
    } catch (err) {
      if (err instanceof OtpError) {
        res.status(err.status === 500 ? 500 : 400).json({ success: false, error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : "Invalid OTP. Please try again.";
      res.status(400).json({ success: false, error: message });
      return;
    }

    await markDraftVerified(cleaned, draft_token);
    res.json({ success: true, message: "OTP verified", verified: true });
  } catch (err) {
    sendError(res, err, "Failed to verify OTP");
  }
});

// Leftover gateway delivery reports. Always 200 so a stale callback URL does not retry.
router.all("/dlr", async (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

export default router;
