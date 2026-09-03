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
  portrait_status?: unknown;
  portrait_error?: unknown;
  generated_at?: Date | string | null;
  finalized_at?: Date | string | null;
  crop_version?: unknown;
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

export const teacherListItem = (teacher: CategoryTeacher, portrait: CatalogPortrait | undefined) => {
  const adminStatus = mapPortraitAdminStatus(portrait, teacher.photo);
  const seen = new Map<string, { id: string; teacher_name: string; photo_url: string; created_at: string | null }>();
  if (adminStatus === "NEEDS_REVIEW") {
    for (const n of teacher.nominations) {
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
  }
  return {
    phone: teacher.phone,
    name: teacher.name,
    kind: teacher.kind,
    photo: teacher.photo,
    nomination_count: teacher.nomination_count,
    portrait_status: adminStatus,
    cropped_cloudinary_url: adminStatus === "GENERATED" ? String(portrait?.cropped_cloudinary_url || "").trim() || null : null,
    source_nomination_id: portrait?.source_nomination_id ? String(portrait.source_nomination_id) : null,
    source_photo_url: teacher.photo === "with_photo" ? teacher.source_photo_url : null,
    portrait_error: portrait?.portrait_error ? String(portrait.portrait_error) : null,
    generated_at: portrait?.generated_at ? new Date(portrait.generated_at).toISOString() : null,
    finalized_at: portrait?.finalized_at ? new Date(portrait.finalized_at).toISOString() : null,
    crop_version: portrait?.crop_version ? String(portrait.crop_version) : null,
    candidates: [...seen.values()],
  };
};
