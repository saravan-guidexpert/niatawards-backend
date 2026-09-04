import { randomUUID } from "crypto";
import { Router, Request, Response } from "express";
import { AfterSessionNomination } from "../models/AfterSessionNomination";
import { Nomination } from "../models/Nomination";
import {
  applyDraftFields,
  assertTeacherPhoneNotNominator,
  cleanPhone,
  draftPayload,
  requireCompleteFields,
  sanitizeEmail,
  sanitizePhotoUrl,
  sanitizeUtm,
  TEACHER_PHONE_SAME_AS_STUDENT_MSG,
  toClientJson,
  utmFromBody,
} from "../lib/afterSessionNomination";

const router = Router();

const VALID_TYPES = ["student", "teacher"] as const;
const CLIENT_FORM_STEPS = ["otp_sent", "details"] as const;

router.get("/", async (req: Request, res: Response) => {
  try {
    const statusParam = String(req.query.status ?? "shortlisted,winner");
    const statuses = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && s !== "draft");

    // Voting page reads existing production nominations only.
    const nominations = await Nomination.find({ status: { $in: statuses } }).sort({
      created_at: -1,
    });
    res.json(nominations.map((n) => n.toJSON()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load nominations";
    res.status(500).json({ error: message });
  }
});

router.get("/draft", async (req: Request, res: Response) => {
  try {
    const token = typeof req.query.draft_token === "string" ? req.query.draft_token.trim() : "";
    if (!token) {
      res.status(400).json({ error: "draft_token is required" });
      return;
    }

    const draft = await AfterSessionNomination.findOne({ draft_token: token, lifecycle: "draft" });
    if (!draft) {
      res.status(404).json({ error: "Draft not found. Please start again." });
      return;
    }

    res.json(draftPayload(draft));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load draft";
    res.status(500).json({ error: message });
  }
});

router.post("/draft", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (!VALID_TYPES.includes(body.type)) {
      res.status(400).json({ error: "type must be student or teacher" });
      return;
    }

    const nominatorName = String(body.nominator_name ?? "").trim();
    const nominatorPhone = cleanPhone(body.nominator_phone ?? body.phone);
    if (!nominatorName) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (nominatorPhone.length !== 10) {
      res.status(400).json({ error: "Enter a valid 10-digit number" });
      return;
    }

    const resume = Boolean(body.resume);
    const draftToken = randomUUID();
    const utm = utmFromBody(body);
    const identity =
      body.type === "teacher"
        ? { full_name: nominatorName, student_name: null }
        : { student_name: nominatorName, full_name: null };

    const existing = await AfterSessionNomination.findOne({
      nominator_phone: nominatorPhone,
      type: body.type,
      lifecycle: "draft",
    });

    if (existing) {
      existing.nominator_name = nominatorName;
      existing.draft_token = draftToken;
      existing.phone_verified = resume;
      if (!existing.phone) existing.phone = nominatorPhone;
      if (!resume) {
        existing.form_step = "identity";
      } else if (existing.form_step === "identity" || existing.form_step === "otp_sent") {
        existing.form_step = "otp_verified";
      }
      if (body.type === "teacher") existing.full_name = nominatorName;
      else existing.student_name = nominatorName;
      for (const [key, value] of Object.entries(utm)) {
        if (value) (existing as unknown as Record<string, unknown>)[key] = value;
      }
      try {
        applyDraftFields(existing, body);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Invalid draft fields" });
        return;
      }
      await existing.save();
      res.json(draftPayload(existing));
      return;
    }

    const draft = await AfterSessionNomination.create({
      type: body.type,
      nominator_name: nominatorName,
      nominator_phone: nominatorPhone,
      phone: nominatorPhone,
      award_category: body.award_category || "General Nomination",
      email: sanitizeEmail(body.email),
      lifecycle: "draft",
      admin_status: "NEW",
      source_form: "inline_draft",
      form_step: resume ? "otp_verified" : "identity",
      phone_verified: resume,
      draft_token: draftToken,
      raw_payload: {},
      extra_fields: {},
      ...identity,
      ...utm,
    });
    try {
      applyDraftFields(draft, body);
      await draft.save();
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid draft fields" });
      return;
    }

    res.status(201).json(draftPayload(draft));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save draft";
    res.status(500).json({ error: message });
  }
});

router.patch("/draft", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const token = typeof body.draft_token === "string" ? body.draft_token.trim() : "";
    if (!token) {
      res.status(400).json({ error: "draft_token is required" });
      return;
    }

    const draft = await AfterSessionNomination.findOne({ draft_token: token, lifecycle: "draft" });
    if (!draft) {
      res.status(404).json({ error: "Draft not found. Please start again." });
      return;
    }

    if (typeof body.type === "string" && body.type !== draft.type) {
      if (!VALID_TYPES.includes(body.type as (typeof VALID_TYPES)[number])) {
        res.status(400).json({ error: "type must be student or teacher" });
        return;
      }
      const nominatorName = (draft.nominator_name ?? "").trim();
      draft.type = body.type as (typeof VALID_TYPES)[number];
      if (draft.type === "teacher") {
        draft.full_name = nominatorName || draft.full_name;
        draft.student_name = null;
        draft.student_class = null;
        draft.teacher_name = null;
        draft.phone = cleanPhone(draft.nominator_phone) || draft.phone;
      } else {
        draft.student_name = nominatorName || draft.student_name;
        draft.full_name = null;
        draft.student_class = null;
        draft.experience = null;
      }
    }

    try {
      applyDraftFields(draft, body);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid photo_url" });
      return;
    }

    if (typeof body.form_step === "string" && CLIENT_FORM_STEPS.includes(body.form_step as (typeof CLIENT_FORM_STEPS)[number])) {
      if (body.form_step === "details" && !draft.phone_verified) {
        res.status(403).json({ error: "Verify OTP before continuing" });
        return;
      }
      draft.form_step = body.form_step as (typeof CLIENT_FORM_STEPS)[number];
    }

    if (body.complete) {
      if (!draft.phone_verified) {
        res.status(403).json({ error: "Verify OTP before submitting" });
        return;
      }
      try {
        requireCompleteFields(draft);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Please complete the form" });
        return;
      }
      draft.lifecycle = "submitted";
      draft.admin_status = "NEW";
      draft.form_step = "submitted";
      draft.submitted_at = new Date();
      draft.source_form = draft.source_form || "inline_draft";
      await draft.save();
      await AfterSessionNomination.updateOne({ _id: draft._id }, { $unset: { draft_token: 1 } });
      const submitted = await AfterSessionNomination.findById(draft._id);
      res.json(toClientJson(submitted ?? draft));
      return;
    }

    await draft.save();
    res.json(draftPayload(draft));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update draft";
    res.status(500).json({ error: message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (!VALID_TYPES.includes(body.type)) {
      res.status(400).json({ error: "type must be student or teacher" });
      return;
    }
    if (!body.phone) {
      res.status(400).json({ error: "phone is required" });
      return;
    }

    try {
      assertTeacherPhoneNotNominator(
        body.type,
        cleanPhone(body.phone),
        cleanPhone(body.nominator_phone)
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : TEACHER_PHONE_SAME_AS_STUDENT_MSG });
      return;
    }

    let photoUrl: string | null = null;
    try {
      photoUrl = sanitizePhotoUrl(body.photo_url);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid photo_url" });
      return;
    }

    const nomination = await AfterSessionNomination.create({
      type: body.type,
      student_name: body.student_name ?? null,
      student_class: body.student_class ?? null,
      class_group: body.class_group ?? null,
      school_name: body.school_name ?? null,
      phone: String(body.phone).trim(),
      teacher_name: body.teacher_name ?? null,
      award_category: body.award_category || "General Nomination",
      special_thing: body.special_thing ?? null,
      subject: body.subject ?? null,
      impact_story: body.impact_story ?? null,
      board: body.board ?? null,
      teacher_social: body.teacher_social ?? null,
      care_rating: body.care_rating ?? null,
      clarity_rating: body.clarity_rating ?? null,
      motivation_rating: body.motivation_rating ?? null,
      support_rating: body.support_rating ?? null,
      full_name: body.full_name ?? null,
      experience: body.experience ?? null,
      photo_url: photoUrl,
      email: sanitizeEmail(body.email),
      nominator_name: body.nominator_name ? String(body.nominator_name).trim() : null,
      nominator_phone: cleanPhone(body.nominator_phone) || null,
      utm_source: sanitizeUtm(body.utm_source),
      utm_medium: sanitizeUtm(body.utm_medium),
      utm_campaign: sanitizeUtm(body.utm_campaign),
      utm_term: sanitizeUtm(body.utm_term),
      utm_content: sanitizeUtm(body.utm_content),
      lifecycle: "submitted",
      admin_status: "NEW",
      source_form: "one_shot_api",
      form_step: "submitted",
      phone_verified: true,
      submitted_at: new Date(),
      extra_fields: {},
      raw_payload: {},
    });
    applyDraftFields(nomination, body);
    await nomination.save();

    res.status(201).json(toClientJson(nomination));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit nomination";
    res.status(500).json({ error: message });
  }
});

export default router;
