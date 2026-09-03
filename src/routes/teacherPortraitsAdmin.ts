import { Router, Request, Response } from "express";
import { Nomination } from "../models/Nomination";
import { TeacherPortrait } from "../models/TeacherPortrait";
import { generateFinalizedPortrait } from "../lib/generateFinalizedPortrait";
import {
  IMAGE_MANAGEMENT_CATEGORIES,
  NOMINATION_KINDS,
  PHOTO_STATES,
  PORTRAIT_ADMIN_STATUSES,
  categoryIdOf,
  usableTeacherPhone,
  type NominationKind,
  type PhotoState,
  type PortraitAdminStatus,
} from "../lib/nominationKind";
import {
  buildCategoryTeachers,
  emptyStatusCounts,
  portraitByPhone,
  teacherListItem,
  type CatalogNomination,
  type CatalogPortrait,
} from "../lib/teacherPortraitCatalog";

const router = Router();

const PAGE_SIZE = 24;

const isKind = (value: unknown): value is NominationKind =>
  NOMINATION_KINDS.includes(String(value) as NominationKind);

const isPhoto = (value: unknown): value is PhotoState =>
  PHOTO_STATES.includes(String(value) as PhotoState);

const isAdminStatus = (value: unknown): value is PortraitAdminStatus =>
  PORTRAIT_ADMIN_STATUSES.includes(String(value) as PortraitAdminStatus);

const loadCatalog = async () => {
  const [nominations, portraits] = await Promise.all([
    Nomination.find({ status: { $ne: "draft" } })
      .select("_id type student_class phone teacher_name full_name nominator_name photo_url created_at")
      .lean(),
    TeacherPortrait.find({}).lean(),
  ]);
  const buckets = buildCategoryTeachers(nominations as CatalogNomination[]);
  const portraitsMap = portraitByPhone(portraits as CatalogPortrait[]);
  return { buckets, portraitsMap };
};

router.get("/summary", async (_req: Request, res: Response) => {
  try {
    const { buckets, portraitsMap } = await loadCatalog();
    const categories = IMAGE_MANAGEMENT_CATEGORIES.map((cat) => {
      const teachers = [...(buckets.get(cat.id)?.values() || [])];
      const status = emptyStatusCounts();
      let nominations = 0;
      for (const teacher of teachers) {
        const item = teacherListItem(teacher, portraitsMap.get(teacher.phone));
        status[item.portrait_status] += 1;
        nominations += teacher.nomination_count;
      }
      return {
        id: cat.id,
        kind: cat.kind,
        photo: cat.photo,
        group: cat.group,
        photoLabel: cat.photoLabel,
        unique_teachers: teachers.length,
        nominations,
        status,
      };
    });
    const kinds = NOMINATION_KINDS.map((kind) => {
      const cats = IMAGE_MANAGEMENT_CATEGORIES.filter((cat) => cat.kind === kind);
      const phones = new Set<string>();
      let nominations = 0;
      for (const cat of cats) {
        for (const teacher of buckets.get(cat.id)?.values() || []) {
          phones.add(teacher.phone);
          nominations += teacher.nomination_count;
        }
      }
      return {
        kind,
        group: cats[0]?.group || kind,
        nominations,
        unique_teachers: phones.size,
      };
    });
    res.json({ categories, kinds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load teacher portrait summary";
    res.status(500).json({ error: message });
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const kind = isKind(req.query.kind) ? req.query.kind : "student";
    const photo = isPhoto(req.query.photo) ? req.query.photo : "with_photo";
    const statusFilter = isAdminStatus(req.query.status) ? req.query.status : null;
    const q = String(req.query.q || "").trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSizeRaw = String(req.query.pageSize || PAGE_SIZE);
    const idsOnly = req.query.ids_only === "1" || req.query.ids_only === "true";
    const categoryId = categoryIdOf(kind, photo);

    const { buckets, portraitsMap } = await loadCatalog();
    let items = [...(buckets.get(categoryId)?.values() || [])].map((teacher) =>
      teacherListItem(teacher, portraitsMap.get(teacher.phone))
    );

    if (statusFilter) items = items.filter((row) => row.portrait_status === statusFilter);
    if (q) {
      items = items.filter(
        (row) => row.name.toLowerCase().includes(q) || row.phone.includes(q)
      );
    }
    items.sort((a, b) => a.name.localeCompare(b.name) || a.phone.localeCompare(b.phone));

    if (idsOnly) {
      res.json({
        phones: items.map((row) => row.phone),
        teachers: items.map((row) => ({ phone: row.phone, name: row.name })),
        total: items.length,
      });
      return;
    }

    const pageSize = pageSizeRaw === "all" ? Math.max(1, items.length) : Math.min(200, Math.max(1, Number(pageSizeRaw) || PAGE_SIZE));
    const total = items.length;
    const start = (page - 1) * pageSize;
    res.json({
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      kind,
      photo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load teacher portraits";
    res.status(500).json({ error: message });
  }
});

const runGenerate = async (req: Request, res: Response, forceRegenerate: boolean) => {
  const body = req.body || {};
  const phones = Array.isArray(body.phones) ? body.phones : [];
  const phone = usableTeacherPhone(body.phone || phones[0] || req.params.phone);
  if (!phone) {
    res.status(400).json({ error: "A valid 10-digit teacher phone is required" });
    return;
  }
  const result = await generateFinalizedPortrait({
    phone,
    regenerate: forceRegenerate || Boolean(body.regenerate),
    source_nomination_id: body.source_nomination_id ? String(body.source_nomination_id) : undefined,
  });
  res.json(result);
};

router.post("/generate", async (req: Request, res: Response) => {
  try {
    await runGenerate(req, res, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate portrait";
    res.status(500).json({ error: message });
  }
});

router.post("/:phone/regenerate", async (req: Request, res: Response) => {
  try {
    await runGenerate(req, res, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to regenerate portrait";
    res.status(500).json({ error: message });
  }
});

export default router;
