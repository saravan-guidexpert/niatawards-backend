import {
  IMAGE_MANAGEMENT_CATEGORIES,
  WITHOUT_PHOTO_BULK_CATEGORY_ID,
  exactCategoryOf,
  type NominationKind,
} from "./nominationKind";
import { loadAdminTeacherCatalog } from "./loadTeacherCatalog";
import { createVideoGenerationJob, planVideosForTeachers, type PlannedVideo } from "./videoGenerationWorker";
import { videoProductionValidity } from "./videoIdentity";
import { PRODUCTION_AUDIO_FILENAME } from "../models/NominationVideo";

export const WITHOUT_PHOTO_CATS = IMAGE_MANAGEMENT_CATEGORIES.filter((cat) => cat.photo === "without_photo");

export type WithoutPhotoBucket = {
  kind: NominationKind;
  category_id: string;
  label: string;
  total: number;
  valid: number;
  invalid: number;
  missing: number;
  pending: number;
  processing: number;
  failed: number;
  blocked: number;
  already_generated: number;
  to_generate: number;
  already_queued: number;
  missing_audio: number;
};

export const auditWithoutPhotoCategories = async () => {
  const { buckets, portraitsMap, videosMap, live } = await loadAdminTeacherCatalog();
  const bucketsOut: WithoutPhotoBucket[] = [];
  const queued: PlannedVideo[] = [];

  for (const cat of WITHOUT_PHOTO_CATS) {
    const teachers = [...(buckets.get(cat.id)?.values() || [])];
    const plan = planVideosForTeachers({
      teachers,
      portraits: portraitsMap,
      videos: videosMap,
      regenerate: false,
      includePortraits: false,
      live,
    });
    queued.push(...plan.queued);

    let valid = 0;
    let invalid = 0;
    let missing = 0;
    let pending = 0;
    let processing = 0;
    let failed = 0;
    let blocked = 0;
    let missingAudio = 0;
    let total = 0;

    for (const teacher of teachers) {
      for (const nominationId of teacher.nomination_ids) {
        total += 1;
        const liveStatus = live.get(nominationId);
        if (liveStatus === "QUEUED" || liveStatus === "PROCESSING") {
          processing += 1;
          continue;
        }
        const video = videosMap.get(nominationId);
        const validity = videoProductionValidity({
          video,
          nominationId,
          expectedKind: teacher.kind,
          expectedPhoto: "without_photo",
        });
        const status = String(video?.generation_status || "");
        if (validity === "VALID") {
          valid += 1;
          if (String(video?.audio_filename || "") !== PRODUCTION_AUDIO_FILENAME) missingAudio += 1;
          continue;
        }
        if (validity === "INVALID") {
          invalid += 1;
          continue;
        }
        if (status === "failed") {
          failed += 1;
          continue;
        }
        if (status === "pending") pending += 1;
        else missing += 1;
      }
    }

    bucketsOut.push({
      kind: cat.kind,
      category_id: cat.id,
      label: exactCategoryOf(cat.kind, cat.photo),
      total,
      valid,
      invalid,
      missing,
      pending,
      processing,
      failed,
      blocked,
      already_generated: plan.already_generated,
      to_generate: plan.queued.length,
      already_queued: plan.already_queued,
      missing_audio: missingAudio,
    });
  }

  return { buckets: bucketsOut, queued, live, portraitsMap, videosMap };
};

export const remainingWithoutPhoto = (rows: WithoutPhotoBucket[]) =>
  rows.reduce(
    (sum, row) => sum + row.invalid + row.missing + row.pending + row.failed + row.blocked + row.processing,
    0
  );

export const createWithoutPhotoBulkJob = async (opts?: { created_by?: string | null; regenerate?: boolean }) => {
  const audit = await auditWithoutPhotoCategories();
  if (!audit.queued.length) {
    return { job: null, audit, queued: 0 };
  }
  const job = await createVideoGenerationJob({
    mode: opts?.regenerate ? "regenerate" : "generate",
    category_id: WITHOUT_PHOTO_BULK_CATEGORY_ID,
    kind: "",
    photo: "without_photo",
    planned: audit.queued,
    blocked: [],
    created_by: opts?.created_by || "without-photo-bulk",
    include_portraits: false,
    job_type: "video",
  });
  return { job, audit, queued: audit.queued.length };
};
