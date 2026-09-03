import {
  IMAGE_MANAGEMENT_CATEGORIES,
  categoryIdOf,
  isSubmittedNomination,
  mapPortraitAdminStatus,
  nominationKind,
  photoStateOf,
  teacherDisplayName,
  usableTeacherPhone,
  type ImageManagementCategoryId,
  type NominationKind,
  type PhotoState,
  type PortraitAdminStatus,
} from "./nominationKind";
import { hasSourcePhoto } from "./sourcePhoto";
import { videoSatisfiesNomination, type VideoIdentityRecord } from "./videoIdentity";

export type CatalogNomination = {
  _id: string;
  status?: unknown;
  type?: unknown;
  student_class?: unknown;
  phone?: unknown;
  teacher_name?: unknown;
  full_name?: unknown;
  nominator_name?: unknown;
  photo_url?: unknown;
  created_at?: Date | string | null;
};

export type CatalogPortrait = {
  teacher_phone?: unknown;
  teacher_name?: unknown;
  source_nomination_id?: unknown;
  source_photo_url?: unknown;
  cropped_cloudinary_url?: unknown;
  updated_at?: unknown;
  portrait_status?: unknown;
  portrait_error?: unknown;
  generated_at?: Date | string | null;
  finalized_at?: Date | string | null;
  crop_version?: unknown;
};

export type CatalogVideo = VideoIdentityRecord & {
  nomination_id: string;
  generation_status?: unknown;
  video_url?: unknown;
  category_icon_id?: unknown;
  category_icon_filename?: unknown;
};

export type VideoLiveStatus = "QUEUED" | "PROCESSING";

export type VideoCounts = {
  generated: number;
  pending: number;
  processing: number;
  failed: number;
  total: number;
};

export const VIDEO_ADMIN_FILTERS = [
  "generated",
  "not_generated",
  "not_generated_finalized",
  "not_generated_no_photo",
  "processing",
  "failed",
] as const;
export type VideoAdminFilter = (typeof VIDEO_ADMIN_FILTERS)[number];

export type VideoTeacherCounts = {
  generated: number;
  not_generated: number;
  not_generated_finalized: number;
  not_generated_no_photo: number;
  processing: number;
  failed: number;
};

export const emptyVideoTeacherCounts = (): VideoTeacherCounts => ({
  generated: 0,
  not_generated: 0,
  not_generated_finalized: 0,
  not_generated_no_photo: 0,
  processing: 0,
  failed: 0,
});

export const isVideoAdminFilter = (value: unknown): value is VideoAdminFilter =>
  VIDEO_ADMIN_FILTERS.includes(String(value) as VideoAdminFilter);

export const matchesVideoAdminFilter = (
  row: { photo: PhotoState; portrait_status: PortraitAdminStatus; videos: VideoCounts },
  filter: VideoAdminFilter
) => {
  const videos = row.videos;
  const remaining = videos.generated < videos.total;
  if (filter === "generated") return videos.total > 0 && videos.generated === videos.total;
  if (filter === "not_generated") return remaining;
  if (filter === "not_generated_finalized") {
    return row.photo === "with_photo" && row.portrait_status === "GENERATED" && remaining;
  }
  if (filter === "not_generated_no_photo") {
    return row.photo === "without_photo" && remaining;
  }
  if (filter === "processing") return videos.processing > 0;
  if (filter === "failed") return videos.failed > 0;
  return true;
};

export type CategoryTeacher = {
  phone: string;
  name: string;
  kind: NominationKind;
  photo: PhotoState;
  category_id: ImageManagementCategoryId;
  nomination_count: number;
  nomination_ids: string[];
  source_photo_url: string | null;
  nominations: CatalogNomination[];
};

const timeOf = (value: unknown) => {
  const ms = new Date(String(value ?? "")).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

export const emptyVideoCounts = (): VideoCounts => ({
  generated: 0,
  pending: 0,
  processing: 0,
  failed: 0,
  total: 0,
});

export const videoCountsFor = (
  nominationIds: string[],
  videos: Map<string, CatalogVideo>,
  live: Map<string, VideoLiveStatus>,
  expectedKind: NominationKind
): VideoCounts => {
  const counts = emptyVideoCounts();
  counts.total = nominationIds.length;
  for (const id of nominationIds) {
    const liveStatus = live.get(id);
    if (liveStatus === "PROCESSING" || liveStatus === "QUEUED") {
      counts.processing += 1;
      continue;
    }
    const video = videos.get(id);
    if (videoSatisfiesNomination({ video, nominationId: id, expectedKind })) {
      counts.generated += 1;
    } else if (String(video?.generation_status || "") === "failed") {
      counts.failed += 1;
    } else {
      counts.pending += 1;
    }
  }
  return counts;
};

export const videoByNomination = (videos: CatalogVideo[]) => {
  const map = new Map<string, CatalogVideo>();
  for (const video of videos) {
    const id = String(video.nomination_id || "");
    if (id) map.set(id, video);
  }
  return map;
};

export const buildCategoryTeachers = (nominations: CatalogNomination[]) => {
  const buckets = new Map<ImageManagementCategoryId, Map<string, CategoryTeacher>>();
  for (const cat of IMAGE_MANAGEMENT_CATEGORIES) {
    buckets.set(cat.id, new Map());
  }

  for (const n of nominations) {
    if (!isSubmittedNomination(n)) continue;
    const phone = usableTeacherPhone(n.phone);
    if (!phone) continue;
    const kind = nominationKind(n);
    const photo = photoStateOf(n.photo_url);
    const categoryId = categoryIdOf(kind, photo);
    const bucket = buckets.get(categoryId);
    if (!bucket) continue;
    const existing = bucket.get(phone);
    if (existing) {
      existing.nominations.push(n);
      existing.nomination_ids.push(String(n._id));
      existing.nomination_count += 1;
      continue;
    }
    bucket.set(phone, {
      phone,
      name: teacherDisplayName(n) || "Unnamed teacher",
      kind,
      photo,
      category_id: categoryId,
      nomination_count: 1,
      nomination_ids: [String(n._id)],
      source_photo_url: hasSourcePhoto(n.photo_url) ? String(n.photo_url) : null,
      nominations: [n],
    });
  }

  for (const bucket of buckets.values()) {
    for (const teacher of bucket.values()) {
      const sorted = [...teacher.nominations].sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at));
      teacher.nominations = sorted;
      teacher.name = teacherDisplayName(sorted[0]) || teacher.name;
      const withPhoto = sorted.find((n) => hasSourcePhoto(n.photo_url));
      teacher.source_photo_url = withPhoto ? String(withPhoto.photo_url) : null;
    }
  }

  return buckets;
};

export const nominationsByPhone = (nominations: CatalogNomination[]) => {
  const map = new Map<string, CatalogNomination[]>();
  for (const n of nominations) {
    if (!isSubmittedNomination(n)) continue;
    const phone = usableTeacherPhone(n.phone);
    if (!phone) continue;
    const list = map.get(phone) || [];
    list.push(n);
    map.set(phone, list);
  }
  return map;
};

const photoCandidates = (noms: CatalogNomination[]) => {
  const seen = new Map<string, { id: string; teacher_name: string; photo_url: string; created_at: string | null }>();
  for (const n of noms) {
    if (!hasSourcePhoto(n.photo_url)) continue;
    const url = String(n.photo_url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.set(url, {
      id: String(n._id),
      teacher_name: teacherDisplayName(n),
      photo_url: url,
      created_at: n.created_at ? new Date(n.created_at).toISOString() : null,
    });
  }
  return [...seen.values()];
};

export const emptyStatusCounts = (): Record<PortraitAdminStatus, number> => ({
  NOT_GENERATED: 0,
  GENERATING: 0,
  GENERATED: 0,
  NEEDS_REVIEW: 0,
  FAILED: 0,
  NO_PHOTO: 0,
});

export const portraitByPhone = (portraits: CatalogPortrait[]) => {
  const map = new Map<string, CatalogPortrait>();
  for (const p of portraits) {
    const phone = usableTeacherPhone(p.teacher_phone) || String(p.teacher_phone || "");
    if (phone) map.set(phone, p);
  }
  return map;
};

export const teacherListItem = (
  teacher: CategoryTeacher,
  portrait: CatalogPortrait | undefined,
  videos?: Map<string, CatalogVideo>,
  live?: Map<string, VideoLiveStatus>,
  allNomsForPhone?: CatalogNomination[]
) => {
  const adminStatus = mapPortraitAdminStatus(portrait, teacher.photo);
  const sourceLocked = Boolean(String(portrait?.source_nomination_id || "").trim());
  const candidates =
    adminStatus === "NEEDS_REVIEW" && !sourceLocked
      ? photoCandidates(allNomsForPhone?.length ? allNomsForPhone : teacher.nominations)
      : [];
  const videoCounts = videoCountsFor(
    teacher.nomination_ids,
    videos || new Map(),
    live || new Map(),
    teacher.kind
  );
  const imageReady = teacher.photo === "without_photo" || adminStatus === "GENERATED";
  return {
    phone: teacher.phone,
    name: teacher.name,
    kind: teacher.kind,
    photo: teacher.photo,
    nomination_count: teacher.nomination_count,
    nomination_ids: teacher.nomination_ids,
    portrait_status: adminStatus,
    cropped_cloudinary_url: adminStatus === "GENERATED" ? String(portrait?.cropped_cloudinary_url || "").trim() || null : null,
    source_nomination_id: portrait?.source_nomination_id ? String(portrait.source_nomination_id) : null,
    source_photo_url: teacher.photo === "with_photo" ? teacher.source_photo_url : null,
    portrait_error: portrait?.portrait_error ? String(portrait.portrait_error) : null,
    generated_at: portrait?.generated_at ? new Date(portrait.generated_at).toISOString() : null,
    finalized_at: portrait?.finalized_at ? new Date(portrait.finalized_at).toISOString() : null,
    crop_version: portrait?.crop_version ? String(portrait.crop_version) : null,
    candidates,
    videos: videoCounts,
    preview_nomination_id: teacher.nomination_ids[0] || null,
    can_generate_image:
      teacher.photo === "with_photo" &&
      adminStatus !== "GENERATED" &&
      adminStatus !== "GENERATING" &&
      (Boolean(teacher.source_photo_url) || sourceLocked || candidates.length > 0),
    can_generate_videos: imageReady && videoCounts.total > 0,
  };
};
