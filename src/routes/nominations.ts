import { randomUUID } from "crypto";
import { Router, Request, Response } from "express";
import { notifyTeacherOnSubmit } from "../lib/teacherSubmitWhatsApp";
import { Nomination } from "../models/Nomination";

const router = Router();

const VALID_TYPES = ["student", "teacher"] as const;
const CLIENT_FORM_STEPS = ["otp_sent", "details"] as const;

const DRAFT_FIELDS = [
  "student_name",
  "student_class",
  "class_group",
  "school_name",
  "phone",
  "teacher_name",
  "award_category",
  "special_thing",
  "subject",
  "impact_story",
  "board",
  "teacher_social",
  "full_name",
  "experience",
] as const;

const cleanPhone = (phone: unknown) => String(phone ?? "").replace(/\D/g, "").slice(-10);
const TEACHER_PHONE_SAME_AS_STUDENT_MSG = "Please enter your nominating teacher's number";

const assertTeacherPhoneNotNominator = (type: string, teacherPhone: string, nominatorPhone: string) => {
  if (type !== "student") return;
  if (teacherPhone.length === 10 && nominatorPhone.length === 10 && teacherPhone === nominatorPhone) {
    throw new Error(TEACHER_PHONE_SAME_AS_STUDENT_MSG);
  }
};

const sanitizePhotoUrl = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("photo_url must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("photo_url is not a valid URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isCloudinary =
    parsed.protocol === "https:" &&
    (host === "res.cloudinary.com" || host.endsWith(".cloudinary.com"));
  if (!isCloudinary) {
    throw new Error("photo_url must be a Cloudinary URL");
  }
  return trimmed;
};

const sanitizeUtm = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 256);
  return trimmed || null;
};

const utmFromBody = (body: Record<string, unknown>) => ({
  utm_source: sanitizeUtm(body.utm_source),
  utm_medium: sanitizeUtm(body.utm_medium),
  utm_campaign: sanitizeUtm(body.utm_campaign),
  utm_term: sanitizeUtm(body.utm_term),
  utm_content: sanitizeUtm(body.utm_content),
});

const draftPayload = (doc: { toJSON: () => Record<string, unknown>; draft_token?: string | null }) => ({
  ...doc.toJSON(),
  draft_token: doc.draft_token,
});

const applyDraftFields = (draft: InstanceType<typeof Nomination>, body: Record<string, unknown>) => {
  for (const field of DRAFT_FIELDS) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (field === "phone") {
      const cleaned = cleanPhone(value);
      if (cleaned.length === 10) {
        assertTeacherPhoneNotNominator(draft.type, cleaned, cleanPhone(draft.nominator_phone));
        draft.phone = cleaned;
      }
      continue;
    }
    if (value == null || value === "") {
      (draft as unknown as Record<string, unknown>)[field] = null;
      continue;
    }
    (draft as unknown as Record<string, unknown>)[field] = String(value).trim();
  }

  if (body.photo_url !== undefined) {
    draft.photo_url = sanitizePhotoUrl(body.photo_url);
  }

  const utm = utmFromBody(body);
  for (const [key, value] of Object.entries(utm)) {
    if (body[key] !== undefined) {
      (draft as unknown as Record<string, unknown>)[key] = value;
    }
  }
};

const requireCompleteFields = (draft: InstanceType<typeof Nomination>) => {
  if (draft.type === "student") {
    if (!draft.student_name?.trim()) throw new Error("Please enter your name");
    if (!draft.student_class?.trim()) throw new Error("Please select your current education");
    if (!draft.school_name?.trim()) throw new Error("Please enter school / college name");
    if (!draft.teacher_name?.trim()) throw new Error("Please enter the teacher's full name");
    if (cleanPhone(draft.phone).length !== 10) throw new Error("Please enter a valid teacher phone number");
    assertTeacherPhoneNotNominator(draft.type, cleanPhone(draft.phone), cleanPhone(draft.nominator_phone));
    if (!draft.special_thing?.trim()) throw new Error("Please fill in what's special about this teacher");
    return;
  }
  if (!draft.full_name?.trim()) throw new Error("Please enter your name");
  if (!draft.school_name?.trim()) throw new Error("Please enter school / college name");
  if (cleanPhone(draft.phone).length !== 10) throw new Error("Please enter a valid phone number");
  if (!draft.subject?.trim()) throw new Error("Please enter your subject");
  if (!draft.experience?.trim()) throw new Error("Please enter years of experience");
  if (!draft.student_class?.trim()) throw new Error("Please select which class you teach");
  if (!draft.impact_story?.trim()) throw new Error("Please share your impact story");
};

router.get("/", async (req: Request, res: Response) => {
  try {
    const statusParam = String(req.query.status ?? "shortlisted,winner");
    const statuses = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && s !== "draft");

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

    const draft = await Nomination.findOne({ draft_token: token, status: "draft" });
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

    const existing = await Nomination.findOne({
      nominator_phone: nominatorPhone,
      type: body.type,
      status: "draft",
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
      await existing.save();
      res.json(draftPayload(existing));
      return;
    }

    const draft = await Nomination.create({
      type: body.type,
      nominator_name: nominatorName,
      nominator_phone: nominatorPhone,
      phone: nominatorPhone,
      award_category: body.award_category || "General Nomination",
      status: "draft",
      form_step: resume ? "otp_verified" : "identity",
      phone_verified: resume,
      draft_token: draftToken,
      ...identity,
      ...utm,
    });

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

    const draft = await Nomination.findOne({ draft_token: token, status: "draft" });
    if (!draft) {
      res.status(404).json({ error: "Draft not found. Please start again." });
      return;
    }

    // Switching between student and teacher rewrites the identity fields, since
    // the same person is the nominee in one case and the nominator in the other.
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
      draft.status = "pending";
      draft.form_step = "submitted";
      await draft.save();
      await Nomination.updateOne({ _id: draft._id }, { $unset: { draft_token: 1 } });
      const submitted = await Nomination.findById(draft._id);
      await notifyTeacherOnSubmit(submitted ?? draft);
      res.json((submitted ?? draft).toJSON());
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

    const nomination = await Nomination.create({
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
      nominator_phone: cleanPhone(body.nominator_phone) || null,
      utm_source: sanitizeUtm(body.utm_source),
      utm_medium: sanitizeUtm(body.utm_medium),
      utm_campaign: sanitizeUtm(body.utm_campaign),
      utm_term: sanitizeUtm(body.utm_term),
      utm_content: sanitizeUtm(body.utm_content),
      status: "pending",
      form_step: "submitted",
      phone_verified: true,
    });

    await notifyTeacherOnSubmit(nomination);
    res.status(201).json(nomination.toJSON());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit nomination";
    res.status(500).json({ error: message });
  }
});

export default router;
