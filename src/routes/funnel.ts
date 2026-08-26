import { Router, Request, Response } from "express";
import { FUNNEL_TRACK_STAGES, FunnelEvent, type FunnelTrackStage } from "../models/FunnelEvent";

const router = Router();

const cleanPhone = (phone: unknown) => String(phone ?? "").replace(/\D/g, "").slice(-10);

const isTrackStage = (value: unknown): value is FunnelTrackStage =>
  typeof value === "string" && (FUNNEL_TRACK_STAGES as readonly string[]).includes(value);

const PRIOR_STAGES: Record<FunnelTrackStage, FunnelTrackStage[]> = {
  otp_requested: ["otp_requested"],
  otp_verified: ["otp_requested", "otp_verified"],
  form_step1: ["otp_requested", "otp_verified", "form_step1"],
};

router.post("/track", async (req: Request, res: Response) => {
  try {
    const stage = req.body?.stage;
    const phone = cleanPhone(req.body?.phone);
    const role = req.body?.role === "teacher" ? "teacher" : req.body?.role === "student" ? "student" : null;

    if (!isTrackStage(stage) || phone.length !== 10) {
      res.json({ ok: true });
      return;
    }

    const now = new Date();
    const doc: Record<string, unknown> = { stage: "", phone, created_at: now };
    if (role) doc.role = role;

    await Promise.all(
      PRIOR_STAGES[stage].map((item) =>
        FunnelEvent.updateOne(
          { stage: item, phone },
          { $setOnInsert: { ...doc, stage: item } },
          { upsert: true }
        )
      )
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

export default router;
