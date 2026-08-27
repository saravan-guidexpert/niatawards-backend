import { Router, Request, Response } from "express";
import { adminAuth, requireAnyPermission, requirePermission, requireSuperAdmin } from "../middleware/adminAuth";
import { Nomination } from "../models/Nomination";
import { FunnelEvent } from "../models/FunnelEvent";
import { DESTINATIONS, PLATFORMS, PromoLink, slugifyInfluencer } from "../models/PromoLink";
import { DigitalCampaignLink } from "../models/DigitalCampaignLink";
import { SmsMessage } from "../models/SmsMessage";
import { AdminUser } from "../models/AdminUser";
import {
  AdminSession,
  SESSION_TTL_MS,
  createSessionToken,
  hashSessionToken,
} from "../models/AdminSession";
import { hashPassword, verifyPassword } from "../lib/passwords";
import { ALL_PANEL_PERMISSIONS, normalizePermissions } from "../lib/permissions";
import { findAdminByUsername, superAdminPassword, superAdminUsername } from "../lib/seedSuperAdmin";
import {
  DIGITAL_STANDARD,
  buildFinalUtmCampaign,
  channelToUtmSource,
  isDigitalChannel,
  isDigitalCreativeType,
  isDigitalLandingToken,
  isDigitalLanguage,
  isDigitalMedium,
  isDigitalState,
  landingTokenToDestination,
  slugifyDigitalField,
} from "../lib/digitalCampaign";

const router = Router();

const VALID_STATUSES = ["pending", "shortlisted", "winner", "rejected"];
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,40}$/;

const normalizeUsername = (value: unknown) => {
  const username = String(value ?? "").trim();
  if (!USERNAME_RE.test(username)) return null;
  return username.toLowerCase();
};

const publicAdmin = (user: { toJSON: () => Record<string, unknown> }) => user.toJSON();

const issueSession = async (adminUserId: string) => {
  const token = createSessionToken();
  await AdminSession.create({
    admin_user_id: adminUserId,
    token_hash: hashSessionToken(token),
    expires_at: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
};

router.post("/login", async (req: Request, res: Response) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password ?? "");
    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    const user = await findAdminByUsername(username);
    const envUser = superAdminUsername();
    const envPass = superAdminPassword();
    const matchesEnv =
      envUser.length > 0 &&
      envPass.length > 0 &&
      username === envUser.toLowerCase() &&
      password === envPass;

    if (!user || !user.active) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const ok = matchesEnv || (await verifyPassword(password, user.password_hash));
    if (!ok) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = await issueSession(String(user._id));
    const json = publicAdmin(user);
    res.json({
      token,
      user: {
        id: json.id,
        username: json.username,
        name: json.name || "",
        role: json.role,
        permissions: user.role === "super_admin" ? [...ALL_PANEL_PERMISSIONS] : json.permissions,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to sign in";
    res.status(500).json({ error: message });
  }
});

router.use(adminAuth);

router.get("/me", (req: Request, res: Response) => {
  res.json({ user: req.admin });
});

router.post("/logout", async (req: Request, res: Response) => {
  try {
    const header = String(req.headers.authorization || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (bearer) {
      await AdminSession.deleteOne({ token_hash: hashSessionToken(bearer) });
    }
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to sign out";
    res.status(500).json({ error: message });
  }
});

router.get("/users", requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const users = await AdminUser.find().sort({ created_at: -1 });
    res.json(users.map((u) => publicAdmin(u)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load admin users";
    res.status(500).json({ error: message });
  }
});

router.post("/users", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const username = normalizeUsername(body.username);
    const password = String(body.password ?? "");
    const name = String(body.name ?? "").trim();
    const permissions = normalizePermissions(body.permissions);

    if (!username) {
      res.status(400).json({ error: "Username must be 3–40 letters, numbers, dots, hyphens, or underscores" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    if (permissions.length === 0) {
      res.status(400).json({ error: "Select at least one admin panel section" });
      return;
    }

    const existing = await findAdminByUsername(username);
    if (existing) {
      res.status(409).json({ error: "That username is already in use" });
      return;
    }

    const user = await AdminUser.create({
      username,
      password_hash: await hashPassword(password),
      name,
      role: "staff",
      permissions,
      active: true,
    });
    res.status(201).json(publicAdmin(user));
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
    if (code === 11000) {
      res.status(409).json({ error: "That username is already in use" });
      return;
    }
    const message = err instanceof Error ? err.message : "Failed to create admin user";
    res.status(500).json({ error: message });
  }
});

router.patch("/users/:id", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const user = await AdminUser.findById(req.params.id);
    if (!user) {
      res.status(404).json({ error: "Admin user not found" });
      return;
    }

    const body = req.body ?? {};

    if (body.name !== undefined) {
      user.name = String(body.name ?? "").trim();
    }

    if (body.permissions !== undefined) {
      if (user.role === "super_admin") {
        user.permissions = [...ALL_PANEL_PERMISSIONS];
      } else {
        const permissions = normalizePermissions(body.permissions);
        if (permissions.length === 0) {
          res.status(400).json({ error: "Select at least one admin panel section" });
          return;
        }
        user.permissions = permissions;
      }
    }

    if (body.active !== undefined) {
      const active = Boolean(body.active);
      if (user.role === "super_admin" && !active) {
        res.status(400).json({ error: "The super admin account cannot be disabled" });
        return;
      }
      user.active = active;
      if (!active) {
        await AdminSession.deleteMany({ admin_user_id: String(user._id) });
      }
    }

    if (body.password !== undefined) {
      const password = String(body.password ?? "");
      if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters" });
        return;
      }
      user.password_hash = await hashPassword(password);
      await AdminSession.deleteMany({ admin_user_id: String(user._id) });
    }

    user.set("updated_at", new Date());
    await user.save();
    res.json(publicAdmin(user));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update admin user";
    res.status(500).json({ error: message });
  }
});

router.delete("/users/:id", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const user = await AdminUser.findById(req.params.id);
    if (!user) {
      res.status(404).json({ error: "Admin user not found" });
      return;
    }
    if (user.role === "super_admin") {
      res.status(400).json({ error: "The super admin account cannot be deleted" });
      return;
    }
    await AdminSession.deleteMany({ admin_user_id: String(user._id) });
    await user.deleteOne();
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete admin user";
    res.status(500).json({ error: message });
  }
});

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

const istDayRange = (day?: string) => {
  const key = String(day ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const start = new Date(`${key}T00:00:00+05:30`);
  const end = new Date(`${key}T24:00:00+05:30`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { created_at: { $gte: start, $lt: end } };
};

router.get(
  "/funnel",
  requireAnyPermission("nominations", "campaigns", "digital"),
  async (req: Request, res: Response) => {
    try {
      const dateFilter = istDayRange(String(req.query.date ?? ""));
      const createdAt = dateFilter ? { created_at: dateFilter.created_at } : {};

      const [otpRequested, otpVerified, step1, nominations] = await Promise.all([
        FunnelEvent.distinct("phone", { stage: "otp_requested", ...createdAt }),
        FunnelEvent.distinct("phone", { stage: "otp_verified", ...createdAt }),
        FunnelEvent.distinct("phone", { stage: "form_step1", ...createdAt }),
        Nomination.find(
          { ...createdAt, status: { $ne: "draft" } },
          { photo_url: 1, status: 1, type: 1 }
        ).lean(),
      ]);

      const submitted = nominations.length;
      const withPhoto = nominations.filter((n) => Boolean(n.photo_url)).length;
      const pending = nominations.filter((n) => n.status === "pending").length;
      const shortlistedOnly = nominations.filter((n) => n.status === "shortlisted").length;
      const winners = nominations.filter((n) => n.status === "winner").length;
      const rejected = nominations.filter((n) => n.status === "rejected").length;
      const shortlisted = shortlistedOnly + winners;
      const students = nominations.filter((n) => n.type === "student").length;
      const teachers = nominations.filter((n) => n.type === "teacher").length;

      const historical = Math.max(0, submitted - step1.length);
      const raw = [
        { id: "otp_requested", label: "OTP requested", hint: "Entered name and phone", count: otpRequested.length + historical },
        { id: "otp_verified", label: "OTP verified", hint: "Verified and continued", count: otpVerified.length + historical },
        { id: "form_step1", label: "Details filled", hint: "Completed form step 1", count: step1.length + historical },
        { id: "submitted", label: "Nominations submitted", hint: "Completed form step 2", count: submitted },
        { id: "shortlisted", label: "Shortlisted", hint: "Moved to next round", count: shortlisted },
        { id: "winners", label: "Winners", hint: "Marked as winner", count: winners },
      ];

      for (let i = raw.length - 2; i >= 0; i -= 1) {
        raw[i].count = Math.max(raw[i].count, raw[i + 1].count);
      }

      res.json({
        stages: raw,
        extras: { withPhoto, pending, rejected, students, teachers, submitted },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load funnel";
      res.status(500).json({ error: message });
    }
  }
);

router.get(
  "/sms-logs",
  requireAnyPermission("nominations", "campaigns", "digital"),
  async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const messages = await SmsMessage.find().sort({ sent_at: -1 }).limit(limit).lean();

      const summary = { accepted: 0, delivered: 0, failed: 0, unknown: 0 };
      for (const m of messages) {
        const key = String(m.status ?? "unknown") as keyof typeof summary;
        if (key in summary) summary[key] += 1;
      }

      res.json({
        summary,
        messages: messages.map((m) => ({
          id: String(m._id),
          request_id: m.request_id ?? null,
          phone: m.phone,
          sender: m.sender ?? null,
          status: m.status,
          gateway_status: m.gateway_status ?? null,
          sent_at: m.sent_at,
          dlr_received_at: m.dlr_received_at ?? null,
          dlr_payload: m.dlr_payload ?? null,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load SMS logs";
      res.status(500).json({ error: message });
    }
  }
);

router.get(
  "/nominations",
  requireAnyPermission("nominations", "campaigns", "digital"),
  async (_req: Request, res: Response) => {
  try {
    const nominations = await Nomination.find({ status: { $ne: "draft" } }).sort({ created_at: -1 });
    res.json(nominations.map((n) => n.toJSON()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load nominations";
    res.status(500).json({ error: message });
  }
});

router.patch("/nominations/:id", requirePermission("nominations"), async (req: Request, res: Response) => {
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

router.get("/promo-links", requirePermission("campaigns"), async (_req: Request, res: Response) => {
  try {
    const links = await PromoLink.find().sort({ created_at: -1 });
    res.json(links.map((l) => l.toJSON()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load promo links";
    res.status(500).json({ error: message });
  }
});

router.post("/promo-links", requirePermission("campaigns"), async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const influencer_name = String(body.influencer_name ?? "").trim();
    const platform = String(body.platform ?? "").trim().toLowerCase();
    const campaign = String(body.campaign ?? "").trim();
    const destination = String(body.destination ?? "").trim();

    if (!influencer_name) {
      res.status(400).json({ error: "Influencer name is required" });
      return;
    }
    if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) {
      res.status(400).json({ error: "Invalid platform" });
      return;
    }
    if (!campaign) {
      res.status(400).json({ error: "Campaign name is required" });
      return;
    }
    if (!DESTINATIONS.includes(destination as (typeof DESTINATIONS)[number])) {
      res.status(400).json({ error: "Invalid destination" });
      return;
    }

    const influencer_slug = slugifyInfluencer(influencer_name);
    const existing = await PromoLink.findOne({
      influencer_slug,
      platform,
      campaign,
      destination,
    });
    if (existing) {
      res.json(existing.toJSON());
      return;
    }

    try {
      const link = await PromoLink.create({
        influencer_name,
        influencer_slug,
        platform,
        campaign,
        destination,
      });
      res.status(201).json(link.toJSON());
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
      if (code === 11000) {
        const dup = await PromoLink.findOne({ influencer_slug, platform, campaign, destination });
        if (dup) {
          res.json(dup.toJSON());
          return;
        }
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create promo link";
    res.status(500).json({ error: message });
  }
});

router.get(
  "/digital-campaign-links",
  requirePermission("digital"),
  async (_req: Request, res: Response) => {
  try {
    const links = await DigitalCampaignLink.find().sort({ created_at: -1 });
    res.json(links.map((l) => l.toJSON()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load digital campaign links";
    res.status(500).json({ error: message });
  }
});

router.post("/digital-campaign-links", requirePermission("digital"), async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const channel = String(body.channel ?? "").trim();
    const state = String(body.state ?? "").trim();
    const language = String(body.language ?? "").trim();
    const creative_type = String(body.creative_type ?? "").trim();
    const utm_medium = String(body.utm_medium ?? "").trim().toLowerCase();
    const audience = slugifyDigitalField(String(body.audience ?? ""));
    const landing_diff = String(body.landing_diff ?? "").trim();
    const creative = slugifyDigitalField(String(body.creative ?? ""));

    if (!isDigitalChannel(channel)) {
      res.status(400).json({ error: "Invalid channel" });
      return;
    }
    if (!isDigitalState(state)) {
      res.status(400).json({ error: "Invalid state" });
      return;
    }
    if (!isDigitalLanguage(language)) {
      res.status(400).json({ error: "Invalid language" });
      return;
    }
    if (!isDigitalCreativeType(creative_type)) {
      res.status(400).json({ error: "Invalid creative type" });
      return;
    }
    if (!isDigitalMedium(utm_medium)) {
      res.status(400).json({ error: "Invalid utm_medium" });
      return;
    }
    if (!isDigitalLandingToken(landing_diff)) {
      res.status(400).json({ error: "Invalid landing page" });
      return;
    }

    const destination = landingTokenToDestination(landing_diff);
    const utm_source = channelToUtmSource(channel);
    const utm_campaign = buildFinalUtmCampaign({
      channel,
      state,
      language,
      audience,
      landingDiff: landing_diff,
      creativeType: creative_type,
      creative,
    });

    if (!utm_campaign) {
      res.status(400).json({ error: "Campaign name is required" });
      return;
    }

    const existing = await DigitalCampaignLink.findOne({
      utm_source,
      utm_medium,
      utm_campaign,
      destination,
    });
    if (existing) {
      res.json(existing.toJSON());
      return;
    }

    try {
      const link = await DigitalCampaignLink.create({
        standard: DIGITAL_STANDARD,
        channel,
        state,
        language,
        audience,
        landing_diff,
        creative_type,
        creative,
        ad_format: "",
        utm_source,
        utm_medium,
        utm_campaign,
        destination,
      });
      res.status(201).json(link.toJSON());
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
      if (code === 11000) {
        const dup = await DigitalCampaignLink.findOne({ utm_source, utm_medium, utm_campaign, destination });
        if (dup) {
          res.json(dup.toJSON());
          return;
        }
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create digital campaign link";
    res.status(500).json({ error: message });
  }
});

export default router;
