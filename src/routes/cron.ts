import { Router, Request, Response } from "express";
import {
  drainQueuedNominationVideoWhatsAppJobs,
  retryFailedNominationVideoWhatsAppJobs,
} from "../lib/nominationVideoWhatsApp";
import { queueNextReadyTeacherVideos } from "../lib/teacherVideoMessaging";
import { scanGroupsNeedingRetries } from "../lib/whatsappRetryOrchestrator";

const router = Router();

const cronSecret = () => (process.env.CRON_SECRET || "").trim();

const authorizeCron = (req: Request) => {
  const expected = cronSecret();
  const header = String(req.headers.authorization || "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const key = String(req.query.key || req.headers["x-cron-secret"] || "");
  if (expected) return bearer === expected || key === expected;
  return String(req.headers["user-agent"] || "").toLowerCase().includes("vercel-cron");
};

router.get("/resume-teacher-video-whatsapp", async (req: Request, res: Response) => {
  if (!authorizeCron(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const retried = await retryFailedNominationVideoWhatsAppJobs();
    const ready = await queueNextReadyTeacherVideos();
    const drained = await drainQueuedNominationVideoWhatsAppJobs();
    res.json({
      ok: true,
      retried,
      ready: { queued: ready.queued, submitted: ready.submitted || 0, remaining: ready.remaining || 0 },
      ...drained,
      remainingFailed: retried.remainingFailed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resume sweep failed";
    console.error("[cron resume-teacher-video-whatsapp]", message);
    res.status(500).json({ error: message });
  }
});

router.get("/retry-teacher-video-whatsapp", async (req: Request, res: Response) => {
  if (!authorizeCron(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const retried = await retryFailedNominationVideoWhatsAppJobs();
    const ready = await queueNextReadyTeacherVideos();
    const drained = await drainQueuedNominationVideoWhatsAppJobs();
    res.json({
      ok: true,
      ...retried,
      readyQueued: ready.queued,
      readySubmitted: ready.submitted || 0,
      remaining: drained.remaining,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retry sweep failed";
    console.error("[cron retry-teacher-video-whatsapp]", message);
    res.status(500).json({ error: message });
  }
});

router.get("/retry-whatsapp", async (req: Request, res: Response) => {
  if (!authorizeCron(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const result = await scanGroupsNeedingRetries();
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retry sweep failed";
    console.error("[cron retry-whatsapp]", message);
    res.status(500).json({ error: message });
  }
});

export default router;
