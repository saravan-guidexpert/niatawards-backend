/** Presentation classification for nominations. Does not change Nomination.type. */

import { hasSourcePhoto } from "./sourcePhoto";
import { phone10 } from "./resolveTeacherPortrait";

export const TEACHER_COLLEAGUE_EDUCATION = "Teacher / Colleague";

export const NOMINATION_KINDS = ["student", "teacher", "colleague"] as const;
export type NominationKind = (typeof NOMINATION_KINDS)[number];

export const PHOTO_STATES = ["with_photo", "without_photo"] as const;
export type PhotoState = (typeof PHOTO_STATES)[number];

export const PORTRAIT_ADMIN_STATUSES = [
  "NOT_GENERATED",
  "GENERATING",
  "GENERATED",
  "NEEDS_REVIEW",
  "FAILED",
  "NO_PHOTO",
] as const;
export type PortraitAdminStatus = (typeof PORTRAIT_ADMIN_STATUSES)[number];

export const IMAGE_MANAGEMENT_CATEGORIES = [
  { id: "student_with_photo", kind: "student", photo: "with_photo", group: "Student nominated teacher", photoLabel: "With photo" },
  { id: "student_without_photo", kind: "student", photo: "without_photo", group: "Student nominated teacher", photoLabel: "Without photo" },
  { id: "teacher_with_photo", kind: "teacher", photo: "with_photo", group: "Teacher nominated teacher", photoLabel: "With photo" },
  { id: "teacher_without_photo", kind: "teacher", photo: "without_photo", group: "Teacher nominated teacher", photoLabel: "Without photo" },
  { id: "colleague_with_photo", kind: "colleague", photo: "with_photo", group: "Teacher nominated other teacher", photoLabel: "With photo" },
  { id: "colleague_without_photo", kind: "colleague", photo: "without_photo", group: "Teacher nominated other teacher", photoLabel: "Without photo" },
] as const;

export type ImageManagementCategoryId = (typeof IMAGE_MANAGEMENT_CATEGORIES)[number]["id"];

const text = (value: unknown) => String(value ?? "").trim();

export const isPlaceholderPhone = (phone: string) => /^(\d)\1{9}$/.test(phone);

export const isSubmittedNomination = (n: { status?: unknown }) => String(n.status || "") !== "draft";

export const nominationKind = (n: { type?: unknown; student_class?: unknown }): NominationKind => {
  if (String(n.type || "") === "teacher") return "teacher";
  if (text(n.student_class) === TEACHER_COLLEAGUE_EDUCATION) return "colleague";
  return "student";
};

export const photoStateOf = (photoUrl: unknown): PhotoState =>
  hasSourcePhoto(photoUrl) ? "with_photo" : "without_photo";

export const teacherDisplayName = (n: {
  type?: unknown;
  student_class?: unknown;
  teacher_name?: unknown;
  full_name?: unknown;
  nominator_name?: unknown;
}) => {
  if (nominationKind(n) === "teacher") {
    return text(n.full_name) || text(n.nominator_name) || text(n.teacher_name);
  }
  return text(n.teacher_name) || text(n.full_name);
};

export const usableTeacherPhone = (value: unknown) => {
  const phone = phone10(value);
  if (phone.length !== 10 || isPlaceholderPhone(phone)) return "";
  return phone;
};

export const categoryIdOf = (kind: NominationKind, photo: PhotoState): ImageManagementCategoryId =>
  `${kind}_${photo}` as ImageManagementCategoryId;

export const isFinalizedPortrait = (portrait: {
  portrait_status?: unknown;
  cropped_cloudinary_url?: unknown;
} | null | undefined) =>
  String(portrait?.portrait_status || "") === "GENERATED" &&
  Boolean(String(portrait?.cropped_cloudinary_url || "").trim());

/** A claim older than this belongs to a run that died; it is no longer generating. */
export const STALE_PORTRAIT_PROCESSING_MS = 8 * 60 * 1000;

export const isStalePortraitClaim = (updatedAt: unknown) => {
  const at = new Date(String(updatedAt || "")).getTime();
  if (!Number.isFinite(at)) return true;
  return Date.now() - at >= STALE_PORTRAIT_PROCESSING_MS;
};

export const mapPortraitAdminStatus = (
  portrait: {
    portrait_status?: unknown;
    cropped_cloudinary_url?: unknown;
    source_nomination_id?: unknown;
    portrait_error?: unknown;
    updated_at?: unknown;
  } | null | undefined,
  categoryPhoto: PhotoState
): PortraitAdminStatus => {
  if (categoryPhoto === "without_photo") return "NO_PHOTO";
  if (!portrait) return "NOT_GENERATED";
  const status = String(portrait.portrait_status || "");
  if (status === "NOT_PROVIDED") return "NO_PHOTO";
  if (status === "PROCESSING") {
    return isStalePortraitClaim(portrait.updated_at) ? "NOT_GENERATED" : "GENERATING";
  }
  if (status === "FAILED") return "FAILED";
  if (isFinalizedPortrait(portrait)) return "GENERATED";
  if (status === "NEEDS_REVIEW") {
    if (String(portrait.source_nomination_id || "").trim()) {
      return String(portrait.portrait_error || "").trim() ? "FAILED" : "NOT_GENERATED";
    }
    return "NEEDS_REVIEW";
  }
  if (status === "PENDING" || !status) return "NOT_GENERATED";
  return "NOT_GENERATED";
};
