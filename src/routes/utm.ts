import { Router, Request, Response } from "express";
import { PromoLink } from "../models/PromoLink";
import { DigitalCampaignLink } from "../models/DigitalCampaignLink";

const router = Router();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TRACKED_DESTINATIONS = new Set(["/", "/nominate-student", "/nominate-teacher"]);

router.post("/hit", async (req: Request, res: Response) => {
  try {
    const source = String(req.body?.utm_source ?? "").trim().toLowerCase().slice(0, 80);
    const medium = String(req.body?.utm_medium ?? "").trim().toLowerCase().slice(0, 80);
    const campaign = String(req.body?.utm_campaign ?? "").trim().slice(0, 256);
    const destination = String(req.body?.destination ?? "").trim();

    if (!source || !medium || !campaign) {
      res.json({ ok: true, matched: false });
      return;
    }

    const campaignMatch = { $regex: `^${escapeRegex(campaign)}$`, $options: "i" };
    const dest = TRACKED_DESTINATIONS.has(destination) ? destination : undefined;

    const tryPromo = async () => {
      const promoFilter: Record<string, unknown> = {
        influencer_slug: medium,
        platform: source,
        campaign: campaignMatch,
      };
      if (dest) promoFilter.destination = dest;

      let link = await PromoLink.findOneAndUpdate(
        promoFilter,
        { $inc: { views: 1 }, $set: { last_click_at: new Date() } },
        { new: true }
      );
      if (!link && dest) {
        const { destination: _d, ...withoutDest } = promoFilter;
        link = await PromoLink.findOneAndUpdate(
          withoutDest,
          { $inc: { views: 1 }, $set: { last_click_at: new Date() } },
          { new: true }
        );
      }
      return Boolean(link);
    };

    const tryDigital = async () => {
      const digitalFilter: Record<string, unknown> = {
        utm_source: source,
        utm_medium: medium,
        utm_campaign: campaignMatch,
      };
      if (dest) digitalFilter.destination = dest;

      let link = await DigitalCampaignLink.findOneAndUpdate(
        digitalFilter,
        { $inc: { views: 1 }, $set: { last_click_at: new Date() } },
        { new: true }
      );
      if (!link && dest) {
        const { destination: _d, ...withoutDest } = digitalFilter;
        link = await DigitalCampaignLink.findOneAndUpdate(
          withoutDest,
          { $inc: { views: 1 }, $set: { last_click_at: new Date() } },
          { new: true }
        );
      }
      return Boolean(link);
    };

    const matched = (await tryDigital()) || (await tryPromo());

    res.json({ ok: true, matched });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to record hit";
    res.status(500).json({ error: message });
  }
});

export default router;
