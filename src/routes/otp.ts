import { Router, Request, Response } from "express";
import { OtpVerification } from "../models/OtpVerification";

const router = Router();

const cleanPhone = (phone: unknown) => String(phone ?? "").replace(/\D/g, "").slice(-10);

router.post("/send", async (req: Request, res: Response) => {
  try {
    const cleaned = cleanPhone(req.body?.phone);
    if (cleaned.length !== 10) {
      res.status(400).json({ error: "Enter a valid 10-digit number" });
      return;
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires_at = new Date(Date.now() + 5 * 60 * 1000);

    await OtpVerification.findOneAndUpdate(
      { phone: cleaned },
      { phone: cleaned, otp, expires_at },
      { upsert: true, new: true }
    );

    const apiKey = process.env.FAST2SMS_API_KEY;
    if (!apiKey) {
      res.status(400).json({ error: "SMS is not configured" });
      return;
    }

    const message = `${otp} is your OTP for NIAT Educator Awards 2026. Valid for 5 minutes. Do not share with anyone.`;
    const params = new URLSearchParams({
      authorization: apiKey,
      route: "q",
      message,
      numbers: cleaned,
      flash: "0",
    });

    const smsRes = await fetch(`https://www.fast2sms.com/dev/bulkV2?${params.toString()}`, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
    });

    const rawText = await smsRes.text();
    console.log("Fast2SMS response:", rawText);

    let smsData: { return?: boolean; message?: string | string[] } = {};
    try {
      smsData = JSON.parse(rawText);
    } catch {
      smsData = { return: false, message: [rawText] };
    }

    if (!smsData.return) {
      const errMsg = Array.isArray(smsData.message)
        ? smsData.message.join(", ")
        : smsData.message || "SMS failed";
      res.status(400).json({ error: errMsg });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    const message = err instanceof Error ? err.message : "Failed to send OTP";
    res.status(500).json({ error: message });
  }
});

router.post("/verify", async (req: Request, res: Response) => {
  try {
    const { phone, otp } = req.body ?? {};
    if (!phone || !otp) {
      res.status(400).json({ error: "Phone and OTP required" });
      return;
    }

    const cleaned = cleanPhone(phone);
    const record = await OtpVerification.findOne({ phone: cleaned });

    if (!record) {
      res.status(400).json({ success: false, error: "OTP not found. Please request a new one." });
      return;
    }

    if (new Date() > record.expires_at) {
      res.status(400).json({ success: false, error: "OTP expired. Please request a new one." });
      return;
    }

    if (record.otp !== String(otp)) {
      res.status(400).json({ success: false, error: "Invalid OTP. Please try again." });
      return;
    }

    await OtpVerification.deleteOne({ phone: cleaned });
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to verify OTP";
    res.status(500).json({ error: message });
  }
});

export default router;
