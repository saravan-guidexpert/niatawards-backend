import { Router, Request, Response } from "express";
import { isDigitalMedium } from "../lib/digitalCampaign";
import { DigitalCampaignLink } from "../models/DigitalCampaignLink";
import { DESTINATIONS, PLATFORMS, PromoLink } from "../models/PromoLink";

const router = Router();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TRACKED_DESTINATIONS = new Set(["/", "/nominate-student", "/nominate-teacher"]);

const isPromoPlatform = (value: string): value is (typeof PLATFORMS)[number] =>
  (PLATFORMS as readonly string[]).includes(value);

const isTrackedDestination = (value: string): value is (typeof DESTINATIONS)[number] =>
  (DESTINATIONS as readonly string[]).includes(value);

router.post("/hit", async (req: Request, res: Response) => {
  try {
    const source = String(req.body?.utm_source ?? "").trim().toLowerCase().slice(0, 80);
    const medium = String(req.body?.utm_medium ?? "").trim().toLowerCase().slice(0, 80);
    const campaign = String(req.body?.utm_campaign ?? "").trim().slice(0, 256);
    const destination = String(req.body?.destination ?? "").trim();
    const content = String(req.body?.utm_content ?? "").trim().slice(0, 120);

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
      if (!link && isPromoPlatform(source) && !isDigitalMedium(medium)) {
        const landing = dest && isTrackedDestination(dest) ? dest : "/";
        const influencer_name = content || medium.replace(/_/g, " ");
        try {
          link = await PromoLink.findOneAndUpdate(
            {
              influencer_slug: medium,
              platform: source,
              campaign,
              destination: landing,
            },
            {
              $setOnInsert: {
                influencer_name,
                influencer_slug: medium,
                platform: source,
                campaign,
                destination: landing,
              },
              $inc: { views: 1 },
              $set: { last_click_at: new Date() },
            },
            { upsert: true, new: true }
          );
        } catch (err) {
          const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
          if (code === 11000) {
            link = await PromoLink.findOneAndUpdate(
              { influencer_slug: medium, platform: source, campaign, destination: landing },
              { $inc: { views: 1 }, $set: { last_click_at: new Date() } },
              { new: true }
            );
          } else {
            throw err;
          }
        }
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
