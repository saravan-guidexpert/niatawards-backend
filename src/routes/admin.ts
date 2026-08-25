import { Router, Request, Response } from "express";
import { adminAuth } from "../middleware/adminAuth";
import { Nomination } from "../models/Nomination";
import { Vote } from "../models/Vote";

const router = Router();
router.use(adminAuth);

const VALID_STATUSES = ["pending", "shortlisted", "winner", "rejected"];

const EDITABLE_FIELDS = [
  "teacher_name",
  "full_name",
  "school_name",
  "award_category",
  "student_name",
  "student_class",
  "phone",
  "subject",
  "special_thing",
  "impact_story",
  "status",
  "experience",
] as const;

router.get("/nominations", async (_req: Request, res: Response) => {
  try {
    const nominations = await Nomination.find().sort({ created_at: -1 });
    res.json(nominations.map((n) => n.toJSON()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load nominations";
    res.status(500).json({ error: message });
  }
});

router.get("/votes", async (_req: Request, res: Response) => {
  try {
    const votes = await Vote.find().sort({ created_at: -1 });
    res.json(votes.map((v) => v.toJSON()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load votes";
    res.status(500).json({ error: message });
  }
});

router.patch("/nominations/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body ?? {};

    if (body.status && !VALID_STATUSES.includes(body.status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }

    const updates: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined) updates[field] = body[field];
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const nomination = await Nomination.findByIdAndUpdate(id, updates, { new: true });
    if (!nomination) {
      res.status(404).json({ error: "Nomination not found" });
      return;
    }

    res.json(nomination.toJSON());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update nomination";
    res.status(500).json({ error: message });
  }
});

export default router;
