import { Router, Request, Response } from "express";
import { Types } from "mongoose";
import { requireSuperAdmin } from "../middleware/adminAuth";
import { WhatsAppMessageEvent } from "../models/WhatsAppMessageEvent";
import { WhatsAppRetryGroup } from "../models/WhatsAppRetryGroup";
import { WhatsAppWebhookEvent } from "../models/WhatsAppWebhookEvent";
import { WhatsAppOptOut } from "../models/WhatsAppOptOut";
import {
  isGupshupOutboundConfigured,
  isWhatsAppEnabled,
  listedConfiguredTemplateEnvKeys,
  listedWhatsAppEnvHints,
  toPhone10,
} from "../lib/gupshup";
import { sendWhatsApp } from "../lib/whatsappSend";
import { IN_FLIGHT_STATUSES, TERMINAL_SUCCESS_STATUSES } from "../lib/whatsappRetryRules";
import {
  TEACHER_SUBMIT_POSTER_URL,
  TEACHER_SUBMIT_WHATSAPP_KIND,
} from "../lib/teacherSubmitWhatsApp";

const router = Router();

const istTodayKey = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const istDayRange = (dateKey: string) => {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : istTodayKey();
  const start = new Date(`${key}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { key, start, end };
};

const shiftIstDay = (dateKey: string, days: number) => {
  const start = new Date(`${dateKey}T12:00:00+05:30`);
  return new Date(start.getTime() + days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

const parseListRange = (req: Request) => {
  const fromRaw = String(req.query.from || req.query.date || "").trim();
  const toRaw = String(req.query.to || req.query.date || "").trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : istTodayKey();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : from;
  const start = istDayRange(from).start;
  const end = istDayRange(to).end;
  return { from, to, start, end: end.getTime() >= start.getTime() ? end : istDayRange(from).end };
};

type RecipientAgg = {
  _id: string;
  statuses: string[];
  kinds: Array<string | null>;
  exclusions: Array<string | null>;
};

const totalsFromRecipients = (rows: RecipientAgg[]) => {
  const totals = {
    recipients: rows.length,
    accepted: 0,
    delivered: 0,
    read: 0,
    permanentFailed: 0,
    transientFailed: 0,
    excluded: 0,
    undelivered: 0,
    exhausted: 0,
    inFlight: 0,
  };
  for (const row of rows) {
    const statuses = new Set(row.statuses || []);
    const delivered = statuses.has("delivered") || statuses.has("read");
    const read = statuses.has("read");
    const accepted = ["submitted", "sent", "delivered", "read"].some((s) => statuses.has(s));
    const exhausted = statuses.has("retry_exhausted");
    const permanent = (row.kinds || []).includes("permanent") || exhausted;
    const transient = (row.kinds || []).includes("transient") && !delivered;
    const excluded = (row.exclusions || []).some(Boolean) && !delivered;
    const inFlight =
      IN_FLIGHT_STATUSES.some((s) => statuses.has(s)) && !delivered && !statuses.has("failed") && !exhausted;
    if (accepted) totals.accepted += 1;
    if (delivered) totals.delivered += 1;
    if (read) totals.read += 1;
    if (permanent && !delivered) totals.permanentFailed += 1;
    if (transient) totals.transientFailed += 1;
    if (excluded) totals.excluded += 1;
    if (exhausted) totals.exhausted += 1;
    if (inFlight) totals.inFlight += 1;
    if (!delivered) totals.undelivered += 1;
  }
  return totals;
};

const recipientMatchAgg = (match: Record<string, unknown>) =>
  WhatsAppMessageEvent.aggregate<RecipientAgg>([
    { $match: match },
    {
      $group: {
        _id: "$phone",
        statuses: { $addToSet: "$status" },
        kinds: { $addToSet: "$terminalFailureKind" },
        exclusions: { $addToSet: "$retryExclusionReason" },
      },
    },
  ]);

const publicMessage = (row: Record<string, unknown>) => ({
  id: String(row._id),
  retryGroupId: row.retryGroupId ? String(row.retryGroupId) : null,
  phone: row.phone,
  messageKind: row.messageKind,
  attemptNumber: row.attemptNumber,
  status: row.status,
  source: row.source,
  retrySource: row.retrySource,
  retryEligible: row.retryEligible,
  retryExclusionReason: row.retryExclusionReason,
  terminalFailureKind: row.terminalFailureKind,
  errorMessage: row.errorMessage,
  webhookErrorCode: row.webhookErrorCode,
  templateIdEnvKey: row.templateIdEnvKey,
  templateId: row.templateId,
  params: row.params,
  gupshupMessageId: row.gupshupMessageId,
  createdAt: row.createdAt,
  sentAt: row.sentAt,
  deliveredAt: row.deliveredAt,
  readAt: row.readAt,
  failedAt: row.failedAt,
});

const emptyStage = (attemptNumber: number) => ({
  attemptNumber,
  title: attemptNumber === 1 ? "Initial Attempt" : attemptNumber === 2 ? "Retry 1" : "Retry 2",
  subtitle:
    attemptNumber === 1 ? "Primary send wave" : attemptNumber === 2 ? "First recovery wave" : "Final recovery wave",
  targeted: 0,
  submitted: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  inFlight: 0,
  excluded: 0,
  successRate: 0,
});

router.get("/meta", async (_req: Request, res: Response) => {
  try {
    const [optOuts, openGroups] = await Promise.all([
      WhatsAppOptOut.countDocuments(),
      WhatsAppRetryGroup.countDocuments({ status: "open" }),
    ]);
    res.json({
      enabled: isWhatsAppEnabled(),
      apiKeyConfigured: Boolean(process.env.GUPSHUP_API_KEY?.trim()),
      sourceConfigured: isGupshupOutboundConfigured(),
      srcNameConfigured: Boolean(process.env.GUPSHUP_SRC_NAME?.trim()),
      webhookSecretConfigured: Boolean(process.env.GUPSHUP_WEBHOOK_SECRET?.trim()),
      cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
      templateEnvKeys: listedConfiguredTemplateEnvKeys(),
      envHints: listedWhatsAppEnvHints(),
      webhookUrl: "/webhook/gupshup",
      cronEndpoint: "/api/cron/retry-whatsapp",
      optOuts,
      openGroups,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load meta";
    res.status(500).json({ error: message });
  }
});

router.get("/overview", async (req: Request, res: Response) => {
  try {
    const { key, start, end } = istDayRange(String(req.query.date || ""));
    const kind = String(req.query.kind || "").trim();
    const match: Record<string, unknown> = { createdAt: { $gte: start, $lt: end } };
    if (kind) match.messageKind = kind;

    const rows = await WhatsAppMessageEvent.aggregate<{
      _id: { attemptNumber: number; phone: string };
      statuses: string[];
      retryEligible: boolean;
      exclusion: string | null;
    }>([
      { $match: match },
      {
        $group: {
          _id: { attemptNumber: "$attemptNumber", phone: "$phone" },
          statuses: { $addToSet: "$status" },
          retryEligible: { $max: "$retryEligible" },
          exclusion: { $last: "$retryExclusionReason" },
        },
      },
    ]);

    const byAttempt: Record<number, ReturnType<typeof emptyStage>> = {
      1: emptyStage(1),
      2: emptyStage(2),
      3: emptyStage(3),
    };

    for (const row of rows) {
      const attempt = Number(row._id.attemptNumber) || 1;
      if (attempt > 3) continue;
      const stage = byAttempt[attempt] || emptyStage(attempt);
      const statuses = new Set(row.statuses || []);
      stage.targeted += 1;
      if (["submitted", "sent", "delivered", "read"].some((s) => statuses.has(s))) stage.submitted += 1;
      if (statuses.has("delivered") || statuses.has("read")) stage.delivered += 1;
      if (statuses.has("read")) stage.read += 1;
      if (statuses.has("failed") || statuses.has("retry_exhausted")) stage.failed += 1;
      if (IN_FLIGHT_STATUSES.some((s) => statuses.has(s)) && !TERMINAL_SUCCESS_STATUSES.some((s) => statuses.has(s))) {
        stage.inFlight += 1;
      }
      if (row.exclusion && !statuses.has("delivered") && !statuses.has("read")) stage.excluded += 1;
      byAttempt[attempt] = stage;
    }

    for (const stage of Object.values(byAttempt)) {
      stage.successRate = stage.targeted ? Math.round((stage.delivered / stage.targeted) * 1000) / 10 : 0;
    }

    const nextGroup = await WhatsAppRetryGroup.findOne({
      status: "open",
      nextPromotionDueAt: { $ne: null },
    })
      .sort({ nextPromotionDueAt: 1 })
      .lean();

    const kinds = await WhatsAppMessageEvent.distinct("messageKind", match);

    const recipients = await recipientMatchAgg(match);
    const totals = totalsFromRecipients(recipients);

    const bucketRows = await WhatsAppMessageEvent.aggregate<{ _id: string | null; count: number }>([
      { $match: { ...match, retryExclusionReason: { $ne: null } } },
      { $group: { _id: "$retryExclusionReason", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const trendDays = 14;
    const trendStartKey = shiftIstDay(key, -(trendDays - 1));
    const trendMatch: Record<string, unknown> = {
      createdAt: { $gte: istDayRange(trendStartKey).start, $lt: end },
    };
    if (kind) trendMatch.messageKind = kind;
    const trendEvents = await WhatsAppMessageEvent.find(trendMatch, {
      phone: 1,
      status: 1,
      terminalFailureKind: 1,
      createdAt: 1,
    }).lean();
    const trendMap = new Map<
      string,
      { phones: Set<string>; delivered: Set<string>; permanent: Set<string>; transient: Set<string> }
    >();
    for (let i = 0; i < trendDays; i += 1) {
      const d = shiftIstDay(trendStartKey, i);
      trendMap.set(d, { phones: new Set(), delivered: new Set(), permanent: new Set(), transient: new Set() });
    }
    for (const event of trendEvents) {
      const d = new Date(event.createdAt as Date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const bucket = trendMap.get(d);
      if (!bucket) continue;
      const phone = String(event.phone);
      bucket.phones.add(phone);
      if (event.status === "delivered" || event.status === "read") bucket.delivered.add(phone);
      if (event.terminalFailureKind === "permanent" || event.status === "retry_exhausted") bucket.permanent.add(phone);
      if (event.terminalFailureKind === "transient") bucket.transient.add(phone);
    }
    const trend = [...trendMap.entries()].map(([date, v]) => ({
      date,
      recipients: v.phones.size,
      delivered: v.delivered.size,
      permanent: v.permanent.size,
      transient: v.transient.size,
    }));

    res.json({
      date: key,
      byAttempt: [byAttempt[1], byAttempt[2], byAttempt[3]],
      totals,
      failureBuckets: bucketRows.map((b) => ({ reason: b._id || "unspecified", count: b.count })),
      trend,
      nextPromotionDueAt: nextGroup?.nextPromotionDueAt || null,
      kinds,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load overview";
    res.status(500).json({ error: message });
  }
});

router.get("/messages", async (req: Request, res: Response) => {
  try {
    const { from, to, start, end } = parseListRange(req);
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const status = String(req.query.status || "").trim();
    const kind = String(req.query.kind || "").trim();
    const attemptRaw = String(req.query.attemptNumber || "").trim();
    const phone = toPhone10(String(req.query.phone || ""));
    const failedOnly = String(req.query.failed || "") === "1";

    const filter: Record<string, unknown> = { createdAt: { $gte: start, $lt: end } };
    if (failedOnly) filter.status = { $in: ["failed", "retry_exhausted"] };
    else if (status) filter.status = status;
    if (kind) filter.messageKind = kind;
    if (attemptRaw) filter.attemptNumber = Number(attemptRaw);
    if (/^\d{10}$/.test(phone)) filter.phone = phone;

    const [items, total] = await Promise.all([
      WhatsAppMessageEvent.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      WhatsAppMessageEvent.countDocuments(filter),
    ]);

    res.json({
      date: from,
      from,
      to,
      page,
      limit,
      total,
      items: items.map((row) => publicMessage(row as unknown as Record<string, unknown>)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load messages";
    res.status(500).json({ error: message });
  }
});

router.get("/retry-groups", async (req: Request, res: Response) => {
  try {
    const { from, to, start, end } = parseListRange(req);
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const status = String(req.query.status || "").trim();
    const filter: Record<string, unknown> = { createdAt: { $gte: start, $lt: end } };
    if (status) filter.status = status;
    const [items, total] = await Promise.all([
      WhatsAppRetryGroup.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      WhatsAppRetryGroup.countDocuments(filter),
    ]);
    res.json({
      from,
      to,
      page,
      limit,
      total,
      items: items.map((row) => ({
        id: String(row._id),
        messageKind: row.messageKind,
        status: row.status,
        trigger: row.trigger,
        nextPromotionDueAt: row.nextPromotionDueAt,
        attempt2TriggeredAt: row.attempt2TriggeredAt,
        attempt3TriggeredAt: row.attempt3TriggeredAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load retry groups";
    res.status(500).json({ error: message });
  }
});

router.get("/webhooks", async (req: Request, res: Response) => {
  try {
    const { from, to, start, end } = parseListRange(req);
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const type = String(req.query.type || "").trim();
    const filter: Record<string, unknown> = { createdAt: { $gte: start, $lt: end } };
    if (type) filter.type = type;
    const [items, total] = await Promise.all([
      WhatsAppWebhookEvent.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      WhatsAppWebhookEvent.countDocuments(filter),
    ]);
    res.json({
      from,
      to,
      page,
      limit,
      total,
      items: items.map((row) => ({
        id: String(row._id),
        type: row.type,
        eventStage: row.eventStage,
        gsId: row.gsId,
        providerId: row.providerId,
        destination: row.destination,
        sourcePhone: row.sourcePhone,
        inboundText: row.inboundText,
        matchedMessageEventId: row.matchedMessageEventId ? String(row.matchedMessageEventId) : null,
        payloadSnippet: row.payloadSnippet,
        createdAt: row.createdAt,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load webhooks";
    res.status(500).json({ error: message });
  }
});

router.get("/cron", async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const today = istDayRange(istTodayKey());
    const [openGroups, dueNow, exhaustedToday, nextGroup] = await Promise.all([
      WhatsAppRetryGroup.countDocuments({ status: "open" }),
      WhatsAppRetryGroup.countDocuments({ status: "open", nextPromotionDueAt: { $ne: null, $lte: now } }),
      WhatsAppRetryGroup.countDocuments({ status: "exhausted", updatedAt: { $gte: today.start, $lt: today.end } }),
      WhatsAppRetryGroup.findOne({ status: "open", nextPromotionDueAt: { $ne: null } })
        .sort({ nextPromotionDueAt: 1 })
        .lean(),
    ]);
    res.json({
      cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
      endpoint: "/api/cron/retry-whatsapp",
      openGroups,
      dueNow,
      exhaustedToday,
      nextPromotionDueAt: nextGroup?.nextPromotionDueAt || null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load cron health";
    res.status(500).json({ error: message });
  }
});

router.post("/actions/test-send", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const phone = toPhone10(String(req.body?.phone || ""));
    const kind = String(req.body?.kind || "test").trim() || "test";
    const params = Array.isArray(req.body?.params)
      ? req.body.params.map((p: unknown) => String(p ?? ""))
      : String(req.body?.params || "")
          .split(",")
          .map((p: string) => p.trim())
          .filter(Boolean);
    const headerImageUrl =
      String(req.body?.headerImageUrl || "").trim() ||
      (kind.replace(/[^a-z0-9_]+/gi, "_").toLowerCase() === TEACHER_SUBMIT_WHATSAPP_KIND
        ? TEACHER_SUBMIT_POSTER_URL
        : null);
    if (!/^\d{10}$/.test(phone)) {
      res.status(400).json({ error: "A 10-digit phone number is required" });
      return;
    }
    const result = await sendWhatsApp({
      kind,
      phone,
      params,
      source: "admin_manual",
      headerImageUrl,
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Test send failed";
    res.status(500).json({ error: message });
  }
});

router.post("/actions/resend", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.body?.id || req.body?.eventId || "");
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Message id is required" });
      return;
    }
    const event = await WhatsAppMessageEvent.findById(id).lean();
    if (!event) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    if (TERMINAL_SUCCESS_STATUSES.includes(event.status as (typeof TERMINAL_SUCCESS_STATUSES)[number])) {
      res.status(409).json({ error: "Already delivered or read" });
      return;
    }
    if (IN_FLIGHT_STATUSES.includes(event.status as (typeof IN_FLIGHT_STATUSES)[number])) {
      res.status(409).json({ error: "Message is still in flight" });
      return;
    }

    const maxRow = await WhatsAppMessageEvent.findOne({ retryGroupId: event.retryGroupId })
      .sort({ attemptNumber: -1 })
      .lean();
    const nextAttempt = Math.min(6, Math.max(4, Number(maxRow?.attemptNumber || event.attemptNumber) + 1));

    const result = await sendWhatsApp({
      kind: event.messageKind,
      phone: event.phone,
      params: Array.isArray(event.params) ? event.params : [],
      source: "admin_manual",
      attemptNumber: nextAttempt,
      retryGroupId: event.retryGroupId,
      parentMessageEventId: event._id,
      headerImageUrl: event.headerImageUrl,
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resend failed";
    res.status(500).json({ error: message });
  }
});

export default router;
