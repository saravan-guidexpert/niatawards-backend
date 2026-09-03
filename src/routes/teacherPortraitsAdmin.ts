import { Router, Request, Response } from "express";
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
  emptyStatusCounts,
  emptyVideoCounts,
  emptyVideoTeacherCounts,
  isVideoAdminFilter,
  matchesVideoAdminFilter,
  teacherListItem,
} from "../lib/teacherPortraitCatalog";
import { loadAdminTeacherCatalog } from "../lib/loadTeacherCatalog";

const router = Router();

const PAGE_SIZE = 24;

const isKind = (value: unknown): value is NominationKind =>
  NOMINATION_KINDS.includes(String(value) as NominationKind);

const isPhoto = (value: unknown): value is PhotoState =>
  PHOTO_STATES.includes(String(value) as PhotoState);

const isAdminStatus = (value: unknown): value is PortraitAdminStatus =>
  PORTRAIT_ADMIN_STATUSES.includes(String(value) as PortraitAdminStatus);

router.get("/summary", async (_req: Request, res: Response) => {
  try {
    const { buckets, portraitsMap, videosMap, live, nomsByPhone } = await loadAdminTeacherCatalog();
    const categories = IMAGE_MANAGEMENT_CATEGORIES.map((cat) => {
      const teachers = [...(buckets.get(cat.id)?.values() || [])];
      const status = emptyStatusCounts();
      const videos = emptyVideoCounts();
      const videoTeachers = emptyVideoTeacherCounts();
      let nominations = 0;
      let notGeneratedFinalizedNoms = 0;
      let notGeneratedNoPhotoNoms = 0;
      for (const teacher of teachers) {
        const item = teacherListItem(teacher, portraitsMap.get(teacher.phone), videosMap, live, nomsByPhone.get(teacher.phone));
        status[item.portrait_status] += 1;
        nominations += teacher.nomination_count;
        videos.generated += item.videos.generated;
        videos.pending += item.videos.pending;
        videos.processing += item.videos.processing;
        videos.failed += item.videos.failed;
        videos.total += item.videos.total;
        const remaining = Math.max(0, item.videos.total - item.videos.generated);
        if (item.videos.total > 0 && remaining === 0) videoTeachers.generated += 1;
        else videoTeachers.not_generated += 1;
        if (remaining > 0 && cat.photo === "with_photo" && item.portrait_status === "GENERATED") {
          videoTeachers.not_generated_finalized += 1;
          notGeneratedFinalizedNoms += remaining;
        }
        if (remaining > 0 && cat.photo === "without_photo") {
          videoTeachers.not_generated_no_photo += 1;
          notGeneratedNoPhotoNoms += remaining;
        }
        if (item.videos.processing > 0) videoTeachers.processing += 1;
        if (item.videos.failed > 0) videoTeachers.failed += 1;
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
        videos: {
          ...videos,
          not_generated: Math.max(0, videos.total - videos.generated),
          not_generated_finalized: notGeneratedFinalizedNoms,
          not_generated_no_photo: notGeneratedNoPhotoNoms,
          teachers: videoTeachers,
        },
        images_finalized: cat.photo === "with_photo" ? status.GENERATED : teachers.length,
        images_pending:
          cat.photo === "with_photo"
            ? status.NOT_GENERATED + status.GENERATING + status.NEEDS_REVIEW + status.FAILED
            : 0,
      };
    });
    const kinds = NOMINATION_KINDS.map((kind) => {
      const catRows = categories.filter((row) => row.kind === kind);
      const meta = IMAGE_MANAGEMENT_CATEGORIES.filter((cat) => cat.kind === kind);
      const phones = new Set<string>();
      for (const cat of meta) {
        for (const teacher of buckets.get(cat.id)?.values() || []) {
          phones.add(teacher.phone);
        }
      }
      const withPhoto = catRows.find((row) => row.photo === "with_photo");
      const withoutPhoto = catRows.find((row) => row.photo === "without_photo");
      return {
        kind,
        group: meta[0]?.group || kind,
        nominations: catRows.reduce((sum, row) => sum + row.nominations, 0),
        unique_teachers: phones.size,
        with_photo: withPhoto?.unique_teachers ?? 0,
        without_photo: withoutPhoto?.unique_teachers ?? 0,
        with_photo_nominations: withPhoto?.nominations ?? 0,
        without_photo_nominations: withoutPhoto?.nominations ?? 0,
        images_finalized: withPhoto?.images_finalized ?? 0,
        images_missing: withPhoto?.images_pending ?? 0,
        videos_generated: catRows.reduce((sum, row) => sum + (row.videos?.generated || 0), 0),
        videos_queued: catRows.reduce((sum, row) => sum + (row.videos?.pending || 0), 0),
        videos_processing: catRows.reduce((sum, row) => sum + (row.videos?.processing || 0), 0),
        videos_failed: catRows.reduce((sum, row) => sum + (row.videos?.failed || 0), 0),
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
    const videoStatus = isVideoAdminFilter(req.query.video_status) ? req.query.video_status : null;
    const q = String(req.query.q || "").trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSizeRaw = String(req.query.pageSize || PAGE_SIZE);
    const idsOnly = req.query.ids_only === "1" || req.query.ids_only === "true";
    const categoryId = categoryIdOf(kind, photo);

    const { buckets, portraitsMap, videosMap, live, nomsByPhone } = await loadAdminTeacherCatalog();
    let items = [...(buckets.get(categoryId)?.values() || [])].map((teacher) =>
      teacherListItem(teacher, portraitsMap.get(teacher.phone), videosMap, live, nomsByPhone.get(teacher.phone))
    );

    if (statusFilter) items = items.filter((row) => row.portrait_status === statusFilter);
    if (videoStatus) items = items.filter((row) => matchesVideoAdminFilter(row, videoStatus));
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
    const message = err instanceof Error ? err.message : "Failed to regenerate teacher portrait";
    res.status(500).json({ error: message });
  }
});

export default router;
