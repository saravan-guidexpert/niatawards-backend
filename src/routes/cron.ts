import { Router, Request, Response } from "express";
import { scanGroupsNeedingRetries } from "../lib/whatsappRetryOrchestrator";

const router = Router();

const cronSecret = () => (process.env.CRON_SECRET || "").trim();

const authorizeCron = (req: Request) => {
  const expected = cronSecret();
  if (!expected) return false;
  const header = String(req.headers.authorization || "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const key = String(req.query.key || req.headers["x-cron-secret"] || "");
  return bearer === expected || key === expected;
};

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
