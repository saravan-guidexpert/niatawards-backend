import { randomBytes } from "crypto";
import { Request, Response, Router } from "express";
import { cleanPhone, generateAndSendOtp, isValidOtp, isValidPhone, OtpError, verifyStoredOtp } from "../lib/otp";
import { FdpRegistration } from "../models/FdpRegistration";
import { OtpVerification } from "../models/OtpVerification";

const router = Router();

const generateRegistrationId = () => {
  const code = randomBytes(3).toString("hex").toUpperCase();
  const year = new Date().getFullYear();
  return `FDP-${year}-${code}`;
};

const sendError = (res: Response, err: unknown, fallback: string) => {
  if (err instanceof OtpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("[FDP Route Error]:", err);
  const message = err instanceof Error ? err.message : fallback;
  res.status(500).json({ error: message });
};

// Step 1: Initiate registration (No OTP required)
router.post("/initiate", async (req: Request, res: Response) => {
  try {
    const fullName = String(req.body?.full_name ?? req.body?.fullName ?? "").trim();
    const rawPhone = req.body?.phone;
    const utm = req.body?.utm;

    if (!fullName || fullName.length < 2) {
      res.status(400).json({ error: "Please enter your full name (at least 2 characters)" });
      return;
    }

    const cleaned = cleanPhone(rawPhone);
    if (!isValidPhone(cleaned)) {
      res.status(400).json({ error: "Please enter a valid 10-digit mobile number" });
      return;
    }

    // Find existing draft or create new registration
    let reg = await FdpRegistration.findOne({ phone: cleaned }).sort({ created_at: -1 });

    if (!reg || reg.status === "submitted") {
      reg = new FdpRegistration({
        registration_id: generateRegistrationId(),
        full_name: fullName,
        phone: cleaned,
        phone_verified: true,
        status: "draft",
        utm: {
          source: String(utm?.source ?? utm?.utm_source ?? ""),
          medium: String(utm?.medium ?? utm?.utm_medium ?? ""),
          campaign: String(utm?.campaign ?? utm?.utm_campaign ?? ""),
          term: String(utm?.term ?? utm?.utm_term ?? ""),
          content: String(utm?.content ?? utm?.utm_content ?? ""),
        },
      });
      await reg.save();
    } else {
      reg.full_name = fullName;
      reg.phone_verified = true;
      if (utm) {
        reg.utm = {
          source: String(utm?.source ?? utm?.utm_source ?? reg.utm?.source ?? ""),
          medium: String(utm?.medium ?? utm?.utm_medium ?? reg.utm?.medium ?? ""),
          campaign: String(utm?.campaign ?? utm?.utm_campaign ?? reg.utm?.campaign ?? ""),
          term: String(utm?.term ?? utm?.utm_term ?? reg.utm?.term ?? ""),
          content: String(utm?.content ?? utm?.utm_content ?? reg.utm?.content ?? ""),
        };
      }
      await reg.save();
    }

    res.json({
      success: true,
      message: "Details saved successfully",
      phone: cleaned,
      registration_id: reg.registration_id,
    });
  } catch (err) {
    sendError(res, err, "Failed to initiate registration");
  }
});

// Step 1: Verify OTP
router.post("/verify-otp", async (req: Request, res: Response) => {
  try {
    const rawPhone = req.body?.phone;
    const rawOtp = req.body?.otp;

    const cleaned = cleanPhone(rawPhone);
    if (!isValidPhone(cleaned)) {
      res.status(400).json({ error: "Enter a valid 10-digit mobile number" });
      return;
    }

    const otpStr = String(rawOtp ?? "").trim();
    if (!isValidOtp(otpStr)) {
      res.status(400).json({ error: "Enter a valid 6-digit OTP" });
      return;
    }

    try {
      await verifyStoredOtp(cleaned, otpStr);
    } catch (err) {
      if (err instanceof OtpError) {
        res.status(err.status === 500 ? 500 : 400).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : "Invalid OTP. Please try again.";
      res.status(400).json({ error: message });
      return;
    }

    const reg = await FdpRegistration.findOneAndUpdate(
      { phone: cleaned },
      { phone_verified: true },
      { sort: { created_at: -1 }, new: true }
    );

    res.json({
      success: true,
      message: "Mobile number verified successfully",
      phone_verified: true,
      registration_id: reg?.registration_id,
    });
  } catch (err) {
    sendError(res, err, "Failed to verify OTP");
  }
});

// Step 1: Resend OTP
router.post("/resend-otp", async (req: Request, res: Response) => {
  try {
    const cleaned = cleanPhone(req.body?.phone);
    if (!isValidPhone(cleaned)) {
      res.status(400).json({ error: "Enter a valid 10-digit mobile number" });
      return;
    }

    await generateAndSendOtp(cleaned);
    res.json({ success: true, message: "OTP resent successfully" });
  } catch (err) {
    sendError(res, err, "Failed to resend OTP");
  }
});

// Step 2: Complete registration
router.post("/complete", async (req: Request, res: Response) => {
  try {
    const cleaned = cleanPhone(req.body?.phone);
    if (!isValidPhone(cleaned)) {
      res.status(400).json({ error: "Invalid mobile number" });
      return;
    }

    const reg = await FdpRegistration.findOne({ phone: cleaned }).sort({ created_at: -1 });
    if (!reg) {
      res.status(404).json({ error: "Registration record not found. Please start from Step 1." });
      return;
    }

    reg.phone_verified = true;

    const teachingSubject = String(req.body?.teaching_subject ?? "").trim();
    const institutionName = String(req.body?.institution_name ?? "").trim();
    const city = String(req.body?.city ?? "").trim();
    const experienceYears = String(req.body?.experience_years ?? "").trim();
    const receiveUpdates = req.body?.receive_updates !== false; // default true unless explicitly false

    if (!teachingSubject) {
      res.status(400).json({ error: "Please enter or select your current teaching subject" });
      return;
    }

    if (!institutionName) {
      res.status(400).json({ error: "Please enter your college or school name" });
      return;
    }

    if (!city) {
      res.status(400).json({ error: "Please enter your current city or town" });
      return;
    }

    if (!experienceYears) {
      res.status(400).json({ error: "Please select your years of experience" });
      return;
    }

    if (!reg.registration_id) {
      reg.registration_id = generateRegistrationId();
    }

    reg.teaching_subject = teachingSubject;
    reg.institution_name = institutionName;
    reg.city = city;
    reg.experience_years = experienceYears;
    reg.receive_updates = receiveUpdates;
    reg.status = "submitted";
    reg.admin_status = "NEW";

    await reg.save();

    res.json({
      success: true,
      message: "Registration completed successfully",
      registration: {
        registration_id: reg.registration_id,
        full_name: reg.full_name,
        phone: reg.phone,
        teaching_subject: reg.teaching_subject,
        institution_name: reg.institution_name,
        city: reg.city,
        experience_years: reg.experience_years,
        receive_updates: reg.receive_updates,
        created_at: reg.created_at,
      },
    });
  } catch (err) {
    sendError(res, err, "Failed to complete registration");
  }
});

export default router;
