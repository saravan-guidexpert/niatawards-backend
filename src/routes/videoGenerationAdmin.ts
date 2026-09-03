import { Router, Request, Response } from "express";
import { VideoGenerationJob, VideoGenerationJobItem } from "../models/VideoGenerationJob";
import { NominationVideo, PRODUCTION_AUDIO_FILENAME } from "../models/NominationVideo";
import {
  NOMINATION_KINDS,
  PHOTO_STATES,
  categoryIdOf,
  exactCategoryOf,
  isFinalizedPortrait,
  teacherDisplayName,
  usableTeacherPhone,
  videoTemplateOf,
  type NominationKind,
  type PhotoState,
} from "../lib/nominationKind";
import { videoSatisfiesNomination } from "../lib/videoIdentity";
import { loadAdminTeacherCatalog } from "../lib/loadTeacherCatalog";
import {
  assertVideoRenderReady,
  bgRemoveRoot,
  materializeCroppedPortrait,
  renderPaths,
  newVideoRenderId,
} from "../lib/renderTeacherVideo";
import { rasterizeCategoryIcon, resolveCategoryIcon, categoryIconLabel } from "../lib/categoryIcons";
import {
  composeNominationPreview,
} from "../lib/generateNominationVideo";
import { portraitConfigError } from "../lib/generateFinalizedPortrait";
import {
  portraitPreviewPath,
  readPreviewIconMeta,
  writePreviewIconMeta,
} from "../lib/teacherPortrait";
import {
  cancelQueuedVideoJob,
  createVideoGenerationJob,
  jobPublicView,
  planVideosForTeachers,
  retryFailedVideoJob,
} from "../lib/videoGenerationWorker";
import fs from "fs";
import path from "path";

const router = Router();

const isKind = (value: unknown): value is NominationKind =>
  NOMINATION_KINDS.includes(String(value) as NominationKind);

const isPhoto = (value: unknown): value is PhotoState =>
  PHOTO_STATES.includes(String(value) as PhotoState);

const requireKindPhoto = (kindRaw: unknown, photoRaw: unknown) => {
  const kind = isKind(kindRaw) ? kindRaw : null;
  const photo = isPhoto(photoRaw) ? photoRaw : null;
  return { kind, photo };
};

const phonesFromBody = (body: Record<string, unknown>) => {
  const raw = Array.isArray(body.phones) ? body.phones : body.phone ? [body.phone] : [];
  return [...new Set(raw.map((value) => usableTeacherPhone(value)).filter(Boolean))];
};

const renderError = () => {
  try {
    assertVideoRenderReady();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : "Video renderer is not available";
  }
};

router.get("/readiness", (_req: Request, res: Response) => {
  const videoError = renderError();
  const portraitError = portraitConfigError();
  // Missing renderer assets must not block the admin UI. This host can still
  // queue jobs; a machine with bg-remove encodes them. Do not return the
  // internal search-path dump as video_error — older UIs treat that as a hard stop.
  res.json({
    video_ready: true,
    video_error: null,
    renders_here: !videoError,
    portrait_ready: !portraitError,
    portrait_error: portraitError || null,
  });
});

router.get("/jobs", async (_req: Request, res: Response) => {
  try {
    const jobs = await VideoGenerationJob.find({}).sort({ created_at: -1 }).limit(20).lean();
    res.json({ jobs: jobs.map((job) => jobPublicView(job)) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load generation jobs";
    res.status(500).json({ error: message });
  }
});

router.get("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const job = await VideoGenerationJob.findById(String(req.params.id || "")).lean();
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const includeItems = req.query.items === "1" || req.query.items === "true";
    const status = String(req.query.status || "").trim().toUpperCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 40));
    let items: unknown[] = [];
    let itemsTotal = 0;
    if (includeItems) {
      const filter: Record<string, unknown> = { job_id: job._id };
      if (["QUEUED", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"].includes(status)) {
        filter.status = status;
      }
      itemsTotal = await VideoGenerationJobItem.countDocuments(filter);
      items = (await VideoGenerationJobItem.find(filter)
        .sort({ created_at: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()).map((row) => ({ ...row, id: row._id }));
    }
    res.json({
      job: jobPublicView(job),
      items,
      items_total: itemsTotal,
      page,
      pageSize,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load job";
    res.status(500).json({ error: message });
  }
});

router.post("/estimate", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const { kind, photo } = requireKindPhoto(body.kind, body.photo);
    const regenerate = Boolean(body.regenerate);
    const phones = phonesFromBody(body);
    if (!kind || !photo) {
      res.status(400).json({ error: "kind and photo are required so videos stay in the selected category" });
      return;
    }
    if (!phones.length) {
      res.status(400).json({ error: "Select one or more teachers" });
      return;
    }
    const { buckets, portraitsMap, videosMap } = await loadAdminTeacherCatalog();
    const categoryId = categoryIdOf(kind, photo);
    const teachers = phones
      .map((phone) => buckets.get(categoryId)?.get(phone))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    const plan = planVideosForTeachers({
      teachers,
      portraits: portraitsMap,
      videos: videosMap,
      regenerate,
    });
    res.json({
      teachers: teachers.length,
      eligible_nominations: plan.eligible_nominations,
      already_generated: plan.already_generated,
      blocked_missing_portrait: plan.blocked_missing_portrait,
      to_generate: plan.queued.length,
      regenerate,
      audio: PRODUCTION_AUDIO_FILENAME,
      audio_attached: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to estimate videos";
    res.status(500).json({ error: message });
  }
});

router.post("/jobs", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const { kind, photo } = requireKindPhoto(body.kind, body.photo);
    const regenerate = Boolean(body.regenerate);
    const phones = phonesFromBody(body);
    if (!kind || !photo) {
      res.status(400).json({ error: "kind and photo are required so videos stay in the selected category" });
      return;
    }
    if (!phones.length) {
      res.status(400).json({ error: "Select one or more teachers" });
      return;
    }
    const { buckets, portraitsMap, videosMap } = await loadAdminTeacherCatalog();
    const categoryId = categoryIdOf(kind, photo);
    const teachers = phones
      .map((phone) => buckets.get(categoryId)?.get(phone))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    const plan = planVideosForTeachers({
      teachers,
      portraits: portraitsMap,
      videos: videosMap,
      regenerate,
    });
    if (!plan.queued.length) {
      res.status(400).json({
        error: regenerate
          ? "No eligible nomination videos to regenerate"
          : "No pending nomination videos to generate",
        teachers: plan.teacher_count,
        eligible_nominations: plan.eligible_nominations,
        already_generated: plan.already_generated,
        blocked_missing_portrait: plan.blocked_missing_portrait,
        to_generate: 0,
      });
      return;
    }
    const createdBy = req.admin?.username || req.admin?.id || null;
    const job = await createVideoGenerationJob({
      mode: regenerate ? "regenerate" : "generate",
      category_id: categoryId,
      kind,
      photo,
      planned: plan.queued,
      created_by: createdBy,
    });
    res.status(202).json({
      job: jobPublicView(job.toObject()),
      queued_videos: plan.queued.length,
      teachers: plan.teacher_count,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start generation job";
    res.status(500).json({ error: message });
  }
});

router.post("/jobs/:id/cancel", async (req: Request, res: Response) => {
  try {
    const job = await cancelQueuedVideoJob(String(req.params.id || ""));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ job: jobPublicView(job.toObject()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to cancel job";
    res.status(500).json({ error: message });
  }
});

router.post("/jobs/:id/retry-failed", async (req: Request, res: Response) => {
  try {
    const createdBy = req.admin?.username || req.admin?.id || null;
    const job = await retryFailedVideoJob(String(req.params.id || ""), createdBy);
    res.status(202).json({ job: jobPublicView(job.toObject()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to retry failed videos";
    res.status(400).json({ error: message });
  }
});

router.get("/videos", async (req: Request, res: Response) => {
  try {
    const phone = usableTeacherPhone(req.query.phone);
    const { kind, photo } = requireKindPhoto(req.query.kind, req.query.photo);
    if (!kind || !photo) {
      res.status(400).json({ error: "kind and photo are required so videos stay in the selected category" });
      return;
    }
    if (!phone) {
      res.status(400).json({ error: "A valid teacher phone is required" });
      return;
    }
    const { buckets } = await loadAdminTeacherCatalog();
    const teacher = buckets.get(categoryIdOf(kind, photo))?.get(phone);
    if (!teacher) {
      res.status(404).json({ error: "Teacher not found in this category" });
      return;
    }
    const docs = await NominationVideo.find({
      nomination_id: { $in: teacher.nomination_ids },
    })
      .select(
        "nomination_id video_url video_render_id generated_at generation_status nomination_kind video_template"
      )
      .lean();
    const byId = new Map(docs.map((doc) => [String(doc.nomination_id), doc]));
    const videos = teacher.nomination_ids.flatMap((nominationId) => {
      const doc = byId.get(nominationId);
      if (
        !videoSatisfiesNomination({
          video: doc,
          nominationId,
          expectedKind: teacher.kind,
        })
      ) {
        return [];
      }
      const videoUrl = String(doc?.video_url || "").trim();
      const nom = teacher.nominations.find((row) => String(row._id) === nominationId);
      const renderId = String(doc?.video_render_id || "").trim();
      return [
        {
          nomination_id: nominationId,
          video_id: doc?._id ? String(doc._id) : null,
          video_url: videoUrl,
          video_render_id: renderId || null,
          generated_at: doc?.generated_at ? new Date(doc.generated_at).toISOString() : null,
          nomination_type: nom?.type ? String(nom.type) : null,
          nomination_kind: teacher.kind,
          exact_category: exactCategoryOf(teacher.kind, teacher.photo),
          video_template: videoTemplateOf(teacher.kind),
          teacher_name: nom ? teacherDisplayName(nom) || teacher.name : teacher.name,
          teacher_phone: teacher.phone,
          label: nom ? teacherDisplayName(nom) || teacher.name : teacher.name,
        },
      ];
    });
    res.json({ phone, name: teacher.name, kind, photo, videos });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load generated videos";
    res.status(500).json({ error: message });
  }
});

router.get("/preview", async (req: Request, res: Response) => {
  try {
    const phone = usableTeacherPhone(req.query.phone);
    const { kind, photo } = requireKindPhoto(req.query.kind, req.query.photo);
    if (!kind || !photo) {
      res.status(400).json({ error: "kind and photo are required so videos stay in the selected category" });
      return;
    }
    if (!phone) {
      res.status(400).json({ error: "A valid teacher phone is required" });
      return;
    }
    const { buckets, portraitsMap, videosMap } = await loadAdminTeacherCatalog();
    const teacher = buckets.get(categoryIdOf(kind, photo))?.get(phone);
    if (!teacher) {
      res.status(404).json({ error: "Teacher not found in this category" });
      return;
    }
    const nominationId = teacher.nomination_ids[0];
    const nom = teacher.nominations[0];
    if (!nominationId || !nom) {
      res.status(404).json({ error: "No nominations for this teacher" });
      return;
    }
    const existingVideo = videosMap.get(nominationId);
    const previewMeta = readPreviewIconMeta(nominationId);
    const root = bgRemoveRoot();
    const icon = resolveCategoryIcon(
      root,
      String(existingVideo?.category_icon_filename || previewMeta?.category_icon_filename || "")
    );
    writePreviewIconMeta(nominationId, {
      category_icon_id: icon.category_icon_id,
      category_icon_filename: icon.category_icon_filename,
    });
    const renderId = newVideoRenderId();
    const paths = renderPaths(root, nominationId, `preview-${renderId}`);
    fs.mkdirSync(paths.renderDir, { recursive: true });
    const iconPng = path.join(paths.renderDir, "category-icon.png");
    rasterizeCategoryIcon(icon.svgPath, iconPng);

    let preparedPath = "";
    if (teacher.photo === "with_photo") {
      const portrait = portraitsMap.get(phone);
      if (!isFinalizedPortrait(portrait)) {
        res.status(409).json({ error: "Finalized image is required for with-photo preview" });
        return;
      }
      preparedPath = await materializeCroppedPortrait({
        dest: paths.preparedPath,
        localPath: null,
        cloudinaryUrl: String(portrait?.cropped_cloudinary_url || ""),
      });
    }
    const dest = portraitPreviewPath(nominationId);
    await composeNominationPreview({
      nominationId,
      teacherName: teacherDisplayName(nom) || teacher.name,
      preparedPortraitPath: preparedPath || null,
      categoryIconPath: iconPng,
      outputPath: dest,
      variant: videoTemplateOf(teacher.kind),
    });
    res.json({
      phone,
      nomination_id: nominationId,
      photo: teacher.photo,
      image_url: teacher.photo === "with_photo" ? String(portraitsMap.get(phone)?.cropped_cloudinary_url || "") : null,
      template_preview_url: `/api/nomination-videos/${nominationId}/portrait-preview?t=${Date.now()}`,
      category_icon_id: icon.category_icon_id,
      category_icon_filename: icon.category_icon_filename,
      category_icon_label: categoryIconLabel(icon.category_icon_filename),
      audio_filename: PRODUCTION_AUDIO_FILENAME,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to build preview";
    res.status(500).json({ error: message });
  }
});

export default router;
