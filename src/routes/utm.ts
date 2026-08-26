import { Router, Request, Response } from "express";
import { PromoLink } from "../models/PromoLink";

const router = Router();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.post("/hit", async (req: Request, res: Response) => {
  try {
    const source = String(req.body?.utm_source ?? "").trim().toLowerCase();
    const medium = String(req.body?.utm_medium ?? "").trim().toLowerCase();
    const campaign = String(req.body?.utm_campaign ?? "").trim();
    const destination = String(req.body?.destination ?? "").trim();

    if (!source || !medium || !campaign) {
      res.json({ ok: true, matched: false });
      return;
    }

    const baseFilter: Record<string, unknown> = {
      influencer_slug: medium,
      platform: source,
      campaign: { $regex: `^${escapeRegex(campaign)}$`, $options: "i" },
    };
    if (destination === "/" || destination === "/nominate-student" || destination === "/nominate-teacher") {
      baseFilter.destination = destination;
    }

    let link = await PromoLink.findOneAndUpdate(
      baseFilter,
      { $inc: { views: 1 }, $set: { last_click_at: new Date() } },
      { new: true }
    );

    if (!link && baseFilter.destination) {
      const { destination: _d, ...withoutDest } = baseFilter;
      link = await PromoLink.findOneAndUpdate(
        withoutDest,
        { $inc: { views: 1 }, $set: { last_click_at: new Date() } },
        { new: true }
      );
    }

    res.json({ ok: true, matched: Boolean(link) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to record hit";
    res.status(500).json({ error: message });
  }
});

export default router;
