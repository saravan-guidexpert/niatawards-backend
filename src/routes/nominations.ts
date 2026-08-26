import { Router, Request, Response } from "express";
import { Nomination } from "../models/Nomination";

const router = Router();

const VALID_TYPES = ["student", "teacher"] as const;

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

router.get("/", async (req: Request, res: Response) => {
  try {
    const statusParam = String(req.query.status ?? "shortlisted,winner");
    const statuses = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const nominations = await Nomination.find({ status: { $in: statuses } }).sort({
      created_at: -1,
    });
    res.json(nominations.map((n) => n.toJSON()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load nominations";
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
      care_rating: body.care_rating ?? null,
      clarity_rating: body.clarity_rating ?? null,
      motivation_rating: body.motivation_rating ?? null,
      support_rating: body.support_rating ?? null,
      full_name: body.full_name ?? null,
      experience: body.experience ?? null,
      photo_url: photoUrl,
      status: "pending",
    });

    res.status(201).json(nomination.toJSON());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit nomination";
    res.status(500).json({ error: message });
  }
});

export default router;
