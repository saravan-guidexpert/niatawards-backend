import { Router, Request, Response } from "express";
import {
  MAX_BULK_IDS,
  listTeacherVideoMessageIds,
  listTeacherVideoMessages,
  previewTeacherVideoMatching,
  previewTeacherVideoQueue,
  progressForEventIds,
  queueTeacherVideoMatching,
  queueTeacherVideoMessages,
  summarizeTeacherVideoMessages,
  type MessagingRowStatus,
} from "../lib/teacherVideoMessaging";
import {
  enqueueNominationVideoWhatsApp,
  queueNominationVideoWhatsAppJob,
} from "../lib/nominationVideoWhatsApp";
import { NOMINATION_KINDS, type NominationKind } from "../lib/nominationKind";

const router = Router();

const parseKind = (value: unknown): NominationKind | "" => {
  const kind = String(value || "").trim();
  return NOMINATION_KINDS.includes(kind as NominationKind) ? (kind as NominationKind) : "";
};

const parsePhoto = (value: unknown): "with_photo" | "without_photo" | "" => {
  const photo = String(value || "").trim();
  if (photo === "with_photo" || photo === "without_photo") return photo;
  return "";
};

const parseStatus = (value: unknown): MessagingRowStatus | "" => {
  const status = String(value || "").trim();
  if (["ready", "queued", "submitted", "sent", "delivered", "read", "failed"].includes(status)) {
    return status as MessagingRowStatus;
  }
  return "";
};

const listFiltersFrom = (input: Record<string, unknown> | Request["query"]) => ({
  kind: parseKind((input as Record<string, unknown>).kind),
  photo: parsePhoto((input as Record<string, unknown>).photo),
  status: parseStatus((input as Record<string, unknown>).status),
  q: String((input as Record<string, unknown>).q || "").trim(),
  testOnly: String((input as Record<string, unknown>).testOnly || "") === "1" || (input as Record<string, unknown>).testOnly === true,
});

const matchingFromBody = (body: Record<string, unknown>) => {
  const raw = body.matching && typeof body.matching === "object" && !Array.isArray(body.matching)
    ? (body.matching as Record<string, unknown>)
    : body.matchAll === true
      ? body
      : null;
  return raw ? listFiltersFrom(raw) : null;
};

const idsFromBody = (body: Record<string, unknown>) => {
  const raw = Array.isArray(body.nominationVideoIds)
    ? body.nominationVideoIds
    : body.nominationVideoId
      ? [body.nominationVideoId]
      : [];
  return [...new Set(raw.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, MAX_BULK_IDS);
};

router.get("/summary", async (req: Request, res: Response) => {
  try {
    const summary = await summarizeTeacherVideoMessages({
      kind: parseKind(req.query.kind),
      photo: parsePhoto(req.query.photo),
      q: String(req.query.q || "").trim(),
      testOnly: String(req.query.testOnly || "") === "1",
    });
    res.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load summary";
    res.status(500).json({ error: message });
  }
});

router.get("/items", async (req: Request, res: Response) => {
  try {
    const result = await listTeacherVideoMessages({
      kind: parseKind(req.query.kind),
      photo: parsePhoto(req.query.photo),
      status: parseStatus(req.query.status),
      q: String(req.query.q || "").trim(),
      testOnly: String(req.query.testOnly || "") === "1",
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 25),
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load videos";
    res.status(500).json({ error: message });
  }
});

router.get("/ids", async (req: Request, res: Response) => {
  try {
    res.json(await listTeacherVideoMessageIds(listFiltersFrom(req.query)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load matching videos";
    res.status(500).json({ error: message });
  }
});

const writeProgress = async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const campaignId = String(req.query.campaignId || body.campaignId || "").trim();
    const ids = String(req.query.eventIds || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const bodyIds = Array.isArray(body.eventIds) ? body.eventIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
    const progress = await progressForEventIds([...ids, ...bodyIds], campaignId);
    res.json(progress);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load progress";
    res.status(500).json({ error: message });
  }
};

router.get("/progress", writeProgress);
router.post("/progress", writeProgress);

router.post("/preview", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const matching = matchingFromBody(body);
    if (matching) {
      res.json(await previewTeacherVideoMatching(matching));
      return;
    }
    const ids = idsFromBody(body);
    if (!ids.length) {
      res.status(400).json({ error: "nominationVideoIds are required" });
      return;
    }
    res.json(await previewTeacherVideoQueue(ids));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to preview queue";
    res.status(500).json({ error: message });
  }
});

router.post("/send", async (req: Request, res: Response) => {
  try {
    const nominationVideoId = String(req.body?.nominationVideoId || "").trim();
    if (!nominationVideoId) {
      res.status(400).json({ error: "nominationVideoId is required" });
      return;
    }
    const queued = await enqueueNominationVideoWhatsApp({
      nominationVideoId,
      allowRetry: Boolean(req.body?.retry),
      source: "admin_manual",
    });
    if (!queued.ok || !queued.shouldSend || !queued.eventId) {
      res.status(queued.duplicate ? 409 : 400).json({
        ok: false,
        queued: false,
        duplicate: queued.duplicate,
        eventId: queued.eventId,
        status: queued.status,
        error: queued.error || "Send failed",
      });
      return;
    }
    queueNominationVideoWhatsAppJob(queued.eventId);
    res.json({
      ok: true,
      queued: true,
      eventId: queued.eventId,
      status: queued.status,
      eventIds: [queued.eventId],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to queue message";
    res.status(500).json({ error: message });
  }
});

router.post("/queue", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const matching = matchingFromBody(body);
    if (matching) {
      res.json({ ok: true, ...await queueTeacherVideoMatching(matching, false) });
      return;
    }
    const ids = idsFromBody(body);
    if (!ids.length) {
      res.status(400).json({ error: "nominationVideoIds are required" });
      return;
    }
    res.json({ ok: true, ...await queueTeacherVideoMessages(ids, false) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to queue messages";
    res.status(500).json({ error: message });
  }
});

router.post("/retry", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const matching = matchingFromBody(body);
    if (matching) {
      res.json({ ok: true, ...await queueTeacherVideoMatching(matching, true) });
      return;
    }
    const ids = idsFromBody(body);
    if (!ids.length) {
      res.status(400).json({ error: "nominationVideoIds are required" });
      return;
    }
    res.json({ ok: true, ...await queueTeacherVideoMessages(ids, true) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to retry messages";
    res.status(500).json({ error: message });
  }
});

export default router;
