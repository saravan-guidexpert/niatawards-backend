/**
 * NominationVideo identity is nomination_id only.
 * Portraits may be reused by teacher phone. Videos must not.
 */

import {
  STUDENT_VIDEO_TEMPLATE,
  TEACHER_NOMINATION_TEMPLATE,
  videoTemplateOf,
  type NominationKind,
  type PhotoState,
  type VideoTemplateVariant,
} from "./nominationKind";

export type VideoIdentityMismatch =
  | "nomination_id_mismatch"
  | "teacher_level_path"
  | "path_nomination_mismatch"
  | "shared_url_other_kind"
  | "stored_template_mismatch"
  | "stored_kind_mismatch"
  | "legacy_unlabeled_non_student";

export type VideoIdentityRecord = {
  id?: unknown;
  _id?: unknown;
  nomination_id?: unknown;
  generation_status?: unknown;
  video_url?: unknown;
  video_render_id?: unknown;
  video_template?: unknown;
  nomination_kind?: unknown;
  photo_used?: unknown;
  video_category?: unknown;
  audio_filename?: unknown;
  production_photo_fallback?: unknown;
};

const hasPlayableUrl = (url: unknown) => /^https?:\/\//i.test(String(url || "").trim());

export const isPlayableGeneratedVideo = (video: VideoIdentityRecord | null | undefined) =>
  String(video?.generation_status || "") === "generated" && hasPlayableUrl(video?.video_url);

export const storedVideoTemplate = (video: VideoIdentityRecord | null | undefined): VideoTemplateVariant | null => {
  const value = String(video?.video_template || "").trim();
  if (value === STUDENT_VIDEO_TEMPLATE || value === TEACHER_NOMINATION_TEMPLATE) return value;
  return null;
};

export const storedNominationKind = (video: VideoIdentityRecord | null | undefined): NominationKind | null => {
  const value = String(video?.nomination_kind || "").trim();
  if (value === "student" || value === "teacher" || value === "colleague") return value;
  return null;
};

/** Cloudinary public_id is niat-awards/teacher-videos/<nomination_id>/<render_id>. */
export const videoPathNominationId = (url: unknown): string | null => {
  const value = String(url || "");
  const match = value.match(/\/teacher-videos\/([^/]+)(?:\/|$)/i);
  if (!match) return null;
  return decodeURIComponent(match[1]);
};

export const isTeacherLevelVideoPath = (url: unknown) => {
  const segment = videoPathNominationId(url);
  return Boolean(segment && /^\d{10}$/.test(segment));
};

export const videoIdentityMismatch = (opts: {
  video: VideoIdentityRecord | null | undefined;
  nominationId: string;
  expectedKind: NominationKind;
  urlOwners?: Map<string, Array<{ nomination_id: string; kind: NominationKind }>>;
}): VideoIdentityMismatch | null => {
  const video = opts.video;
  const nominationId = String(opts.nominationId || "").trim();
  if (!video || !nominationId) return "nomination_id_mismatch";
  if (String(video.nomination_id || "").trim() !== nominationId) return "nomination_id_mismatch";
  if (!isPlayableGeneratedVideo(video)) return null;

  const url = String(video.video_url || "").trim();
  if (isTeacherLevelVideoPath(url)) return "teacher_level_path";
  const pathNom = videoPathNominationId(url);
  if (pathNom && pathNom !== nominationId) return "path_nomination_mismatch";

  const owners = opts.urlOwners?.get(url);
  if (owners && owners.some((row) => row.kind !== opts.expectedKind && row.nomination_id !== nominationId)) {
    return "shared_url_other_kind";
  }

  const template = storedVideoTemplate(video);
  const expectedTemplate = videoTemplateOf(opts.expectedKind);
  if (template && template !== expectedTemplate) return "stored_template_mismatch";

  const kind = storedNominationKind(video);
  if (kind && kind !== opts.expectedKind) return "stored_kind_mismatch";

  // Older student bulk used type=student, which includes colleague nominations,
  // and rendered the student template onto those nomination_ids. Preserve the
  // records but do not treat them as Teacher Nominated Other Teacher videos.
  // Teacher-self rows were never in that student bulk (type=teacher).
  if (!template && !kind && opts.expectedKind === "colleague") return "legacy_unlabeled_non_student";

  return null;
};

export const videoSatisfiesNomination = (opts: {
  video: VideoIdentityRecord | null | undefined;
  nominationId: string;
  expectedKind: NominationKind;
  urlOwners?: Map<string, Array<{ nomination_id: string; kind: NominationKind }>>;
}) => isPlayableGeneratedVideo(opts.video) && !videoIdentityMismatch(opts);

/**
 * Photo state is taken from the nomination source photo, never from TeacherPortrait.
 * A with-photo nomination playing a without-photo MP4 is INVALID even if identity matches.
 */
export const videoMatchesPhotoState = (
  video: VideoIdentityRecord | null | undefined,
  expectedPhoto: PhotoState
) => {
  const fallbackWithoutPhoto =
    video?.production_photo_fallback === true &&
    video?.photo_used !== true &&
    video?.video_category !== "with_photo";
  if (fallbackWithoutPhoto) return true;
  if (expectedPhoto === "with_photo") {
    return video?.photo_used === true && video?.video_category === "with_photo";
  }
  return video?.photo_used !== true && video?.video_category !== "with_photo";
};

export type ProductionValidity = "VALID" | "INVALID" | "MISSING";

export const videoProductionValidity = (opts: {
  video: VideoIdentityRecord | null | undefined;
  nominationId: string;
  expectedKind: NominationKind;
  expectedPhoto: PhotoState;
  urlOwners?: Map<string, Array<{ nomination_id: string; kind: NominationKind }>>;
}): ProductionValidity => {
  if (!isPlayableGeneratedVideo(opts.video)) return "MISSING";
  if (videoIdentityMismatch(opts)) return "INVALID";
  if (!videoMatchesPhotoState(opts.video, opts.expectedPhoto)) return "INVALID";
  return "VALID";
};

export const videoProductionValid = (opts: {
  video: VideoIdentityRecord | null | undefined;
  nominationId: string;
  expectedKind: NominationKind;
  expectedPhoto: PhotoState;
  urlOwners?: Map<string, Array<{ nomination_id: string; kind: NominationKind }>>;
}) => videoProductionValidity(opts) === "VALID";

export const buildVideoUrlOwners = (
  rows: Array<{ nomination_id: string; kind: NominationKind; video_url?: unknown; generation_status?: unknown }>
) => {
  const map = new Map<string, Array<{ nomination_id: string; kind: NominationKind }>>();
  for (const row of rows) {
    if (String(row.generation_status || "") !== "generated") continue;
    const url = String(row.video_url || "").trim();
    if (!hasPlayableUrl(url)) continue;
    const list = map.get(url) || [];
    list.push({ nomination_id: row.nomination_id, kind: row.kind });
    map.set(url, list);
  }
  return map;
};
