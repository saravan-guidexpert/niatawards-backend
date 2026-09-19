import { Request, Response, Router } from "express";
import { FDP_ADMIN_STATUSES, FdpAdminStatus, FdpRegistration } from "../models/FdpRegistration";

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

const buildFilter = (query: Request["query"]) => {
  const search = String(query.search ?? "").trim();
  const status = String(query.status ?? "").trim().toUpperCase();
  const experience = String(query.experience ?? "").trim();
  const receiveUpdates = String(query.receive_updates ?? "").trim();
  const city = String(query.city ?? "").trim();
  const subject = String(query.subject ?? "").trim();
  const lifecycle = String(query.lifecycle ?? "submitted").trim();
  const date = istDayRange(String(query.date ?? ""));

  const filter: Record<string, unknown> = {};

  if (lifecycle === "draft" || lifecycle === "submitted") {
    filter.status = lifecycle;
  } else if (lifecycle !== "all") {
    filter.status = "submitted";
  }

  if (FDP_ADMIN_STATUSES.includes(status as FdpAdminStatus)) {
    filter.admin_status = status;
  }

  if (experience && experience !== "all") {
    filter.experience_years = experience;
  }

  if (receiveUpdates === "true" || receiveUpdates === "yes") {
    filter.receive_updates = true;
  } else if (receiveUpdates === "false" || receiveUpdates === "no") {
    filter.receive_updates = false;
  }

  if (city && city !== "all") {
    filter.city = new RegExp(`^${escapeRegex(city)}$`, "i");
  }

  if (subject && subject !== "all") {
    filter.teaching_subject = new RegExp(`^${escapeRegex(subject)}$`, "i");
  }

  if (date) {
    filter.created_at = date;
  }

  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    const digits = search.replace(/\D/g, "");
    filter.$or = [
      { full_name: rx },
      { teaching_subject: rx },
      { institution_name: rx },
      { city: rx },
      { registration_id: rx },
      ...(digits ? [{ phone: new RegExp(digits) }] : []),
    ];
  }

  return filter;
};

// 1. Paginated list
router.get("/", async (req: Request, res: Response) => {
  try {
    const rawLimit = String(req.query.limit ?? "").toLowerCase();
    const isAll = rawLimit === "all" || rawLimit === "0" || rawLimit === "-1";
    const limit = isAll ? 10000 : Math.min(500, Math.max(1, Number(req.query.limit) || 25));
    const page = isAll ? 1 : Math.max(1, Number(req.query.page) || 1);
    const filter = buildFilter(req.query);

    const [total, items] = await Promise.all([
      FdpRegistration.countDocuments(filter),
      FdpRegistration.find(filter)
        .sort({ created_at: -1 })
        .skip(isAll ? 0 : (page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    res.json({
      items,
      total,
      page,
      limit: isAll ? total : limit,
      pages: isAll ? 1 : Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load FDP registrations";
    res.status(500).json({ error: message });
  }
});

// 2. Metrics & Dashboard Stats
router.get("/stats", async (_req: Request, res: Response) => {
  try {
    const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const todayFilter = istDayRange(todayIST);

    const [total, todayCount, optedInCount, statusAgg, subjectAgg, cityAgg] = await Promise.all([
      FdpRegistration.countDocuments({ status: "submitted" }),
      todayFilter ? FdpRegistration.countDocuments({ status: "submitted", created_at: todayFilter }) : 0,
      FdpRegistration.countDocuments({ status: "submitted", receive_updates: true }),
      FdpRegistration.aggregate([
        { $match: { status: "submitted" } },
        { $group: { _id: "$admin_status", count: { $sum: 1 } } },
      ]),
      FdpRegistration.aggregate([
        { $match: { status: "submitted", teaching_subject: { $ne: "" } } },
        { $group: { _id: "$teaching_subject", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      FdpRegistration.aggregate([
        { $match: { status: "submitted", city: { $ne: "" } } },
        { $group: { _id: "$city", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const statusCounts: Record<string, number> = {
      NEW: 0,
      CONTACTED: 0,
      CONFIRMED: 0,
      ARCHIVED: 0,
    };
    statusAgg.forEach((item) => {
      if (item._id) statusCounts[item._id] = item.count;
    });

    res.json({
      total,
      today: todayCount,
      optedInUpdates: optedInCount,
      optedInPct: total > 0 ? Math.round((optedInCount / total) * 100) : 0,
      statusCounts,
      topSubjects: subjectAgg.map((s) => ({ subject: s._id, count: s.count })),
      topCities: cityAgg.map((c) => ({ city: c._id, count: c.count })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load FDP statistics";
    res.status(500).json({ error: message });
  }
});

// 3. Export CSV
router.get("/export", async (req: Request, res: Response) => {
  try {
    const filter = buildFilter(req.query);
    const items = await FdpRegistration.find(filter).sort({ created_at: -1 }).lean();

    const headers = [
      "Registration ID",
      "Full Name",
      "Phone",
      "Teaching Subject",
      "Institution Name",
      "City/Town",
      "Experience (Years)",
      "Receive Future Updates",
      "Admin Status",
      "Admin Notes",
      "Registration Date (IST)",
    ];

    const escapeCsv = (val: unknown) => {
      const str = String(val ?? "").replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = items.map((reg) => [
      escapeCsv(reg.registration_id || ""),
      escapeCsv(reg.full_name || ""),
      escapeCsv(reg.phone || ""),
      escapeCsv(reg.teaching_subject || ""),
      escapeCsv(reg.institution_name || ""),
      escapeCsv(reg.city || ""),
      escapeCsv(reg.experience_years || ""),
      escapeCsv(reg.receive_updates ? "Yes" : "No"),
      escapeCsv(reg.admin_status || "NEW"),
      escapeCsv(reg.admin_notes || ""),
      escapeCsv(
        reg.created_at ? new Date(reg.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""
      ),
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const dateTag = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="fdp_registrations_${dateTag}.csv"`);
    res.status(200).send(csvContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to export FDP registrations";
    res.status(500).json({ error: message });
  }
});

// 4. Single item
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const doc = await FdpRegistration.findById(req.params.id).lean();
    if (!doc) {
      res.status(404).json({ error: "Registration not found" });
      return;
    }
    res.json(doc);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load registration";
    res.status(500).json({ error: message });
  }
});

// 5. Update status / notes
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { admin_status, admin_notes } = req.body ?? {};
    const update: Record<string, unknown> = {};

    if (admin_status) {
      const statusUpper = String(admin_status).trim().toUpperCase();
      if (!FDP_ADMIN_STATUSES.includes(statusUpper as FdpAdminStatus)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${FDP_ADMIN_STATUSES.join(", ")}` });
        return;
      }
      update.admin_status = statusUpper;
    }

    if (admin_notes !== undefined) {
      update.admin_notes = String(admin_notes).trim();
    }

    const doc = await FdpRegistration.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!doc) {
      res.status(404).json({ error: "Registration not found" });
      return;
    }

    res.json({ success: true, item: doc });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update registration";
    res.status(500).json({ error: message });
  }
});

// 6. Delete
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const doc = await FdpRegistration.findByIdAndDelete(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "Registration not found" });
      return;
    }
    res.json({ success: true, message: "Registration deleted successfully" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete registration";
    res.status(500).json({ error: message });
  }
});

export default router;
