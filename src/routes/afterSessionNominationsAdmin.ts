import { Router, Request, Response } from "express";
import {
  AFTER_SESSION_ADMIN_STATUSES,
  AfterSessionNomination,
} from "../models/AfterSessionNomination";
import { toAdminJson } from "../lib/afterSessionNomination";

const router = Router();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const istDayRange = (day?: string) => {
  const key = String(day ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const start = new Date(`${key}T00:00:00+05:30`);
  const end = new Date(`${key}T24:00:00+05:30`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { $gte: start, $lt: end };
};

router.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const search = String(req.query.search ?? "").trim();
    const type = String(req.query.type ?? "").trim();
    const sourceForm = String(req.query.source_form ?? "").trim();
    const status = String(req.query.status ?? "").trim().toUpperCase();
    const lifecycle = String(req.query.lifecycle ?? "submitted").trim();
    const date = istDayRange(String(req.query.date ?? ""));
    const submissionId = String(req.query.id ?? "").trim();

    const filter: Record<string, unknown> = {};
    if (lifecycle === "draft" || lifecycle === "submitted") {
      filter.lifecycle = lifecycle;
    } else if (lifecycle !== "all") {
      filter.lifecycle = "submitted";
    }
    if (type === "student" || type === "teacher") filter.type = type;
    if (sourceForm) filter.source_form = sourceForm;
    if (AFTER_SESSION_ADMIN_STATUSES.includes(status as (typeof AFTER_SESSION_ADMIN_STATUSES)[number])) {
      filter.admin_status = status;
    }
    if (date) filter.created_at = date;
    if (submissionId) filter._id = submissionId;

    if (search && !submissionId) {
      const rx = new RegExp(escapeRegex(search), "i");
      const digits = search.replace(/\D/g, "");
      filter.$or = [
        { teacher_name: rx },
        { full_name: rx },
        { student_name: rx },
        { nominator_name: rx },
        { school_name: rx },
        { email: rx },
        { _id: rx },
        ...(digits ? [{ phone: new RegExp(digits) }, { nominator_phone: new RegExp(digits) }] : []),
      ];
    }

    const [total, items] = await Promise.all([
      AfterSessionNomination.countDocuments(filter),
      AfterSessionNomination.find(filter)
        .select("-draft_token -__v")
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    res.json({
      items: items.map((doc) => toAdminJson(doc as Record<string, unknown>)),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load after-session nominations";
    res.status(500).json({ error: message });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const doc = await AfterSessionNomination.findById(req.params.id).select("-draft_token -__v").lean();
    if (!doc) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    res.json(toAdminJson(doc as Record<string, unknown>));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load submission";
    res.status(500).json({ error: message });
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const next = String(req.body?.status ?? "").trim().toUpperCase();
    if (!AFTER_SESSION_ADMIN_STATUSES.includes(next as (typeof AFTER_SESSION_ADMIN_STATUSES)[number])) {
      res.status(400).json({ error: "status must be NEW, VIEWED, or ARCHIVED" });
      return;
    }
    const doc = await AfterSessionNomination.findByIdAndUpdate(
      req.params.id,
      { admin_status: next, updated_at: new Date() },
      { new: true }
    );
    if (!doc) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    res.json(toAdminJson(doc));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update status";
    res.status(500).json({ error: message });
  }
});

export default router;
