/** Resolve the TeacherPortrait that is safe to use for a specific nomination. */

export const phone10 = (value: unknown) => String(value ?? "").replace(/\D/g, "").slice(-10);

const cloudinaryPortraitPhone = (url: unknown) => {
  const value = String(url || "");
  const match = value.match(/\/teacher-portraits\/(\d{10})(?:-top60)?/);
  return match ? match[1] : "";
};

const normalizeName = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(sir|mam|maam|ji|mrs|mr|ms|dr|smt|shri|prof)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const namesCompatible = (a: unknown, b: unknown) => {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return true;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const tokens = (name: string) => new Set(name.split(" ").filter((t) => t.length > 2));
  const aTok = tokens(left);
  const bTok = tokens(right);
  let overlap = 0;
  for (const t of aTok) if (bTok.has(t)) overlap += 1;
  return overlap >= 1;
};

export type PortraitMapping = "MATCH" | "MISMATCH" | "NO_PORTRAIT";

export type ResolvedTeacherPortrait = {
  teacher_phone: string;
  portrait_phone: string | null;
  mapping: PortraitMapping;
  usable: boolean;
  portrait_cloudinary_url: string | null;
  cropped_local_png_path: string | null;
  portrait_id: string | null;
  reason: string;
};

type NominationLike = {
  id?: unknown;
  _id?: unknown;
  phone?: unknown;
  teacher_name?: unknown;
  photo_url?: unknown;
};

type PortraitLike = {
  _id?: unknown;
  id?: unknown;
  teacher_phone?: unknown;
  teacher_name?: unknown;
  source_nomination_id?: unknown;
  source_photo_url?: unknown;
  portrait_cloudinary_url?: unknown;
  cropped_cloudinary_url?: unknown;
  cropped_local_png_path?: unknown;
  portrait_status?: unknown;
};

export const resolveTeacherPortrait = (
  nomination: NominationLike,
  portrait: PortraitLike | null | undefined
): ResolvedTeacherPortrait => {
  const teacherPhone = phone10(nomination.phone);
  if (!portrait) {
    return {
      teacher_phone: teacherPhone,
      portrait_phone: null,
      mapping: "NO_PORTRAIT",
      usable: false,
      portrait_cloudinary_url: null,
      cropped_local_png_path: null,
      portrait_id: null,
      reason: "no_teacher_portrait",
    };
  }

  const portraitPhone = phone10(portrait.teacher_phone);
  const cropped = String(portrait.cropped_cloudinary_url || "").trim();
  const urlPhone = cloudinaryPortraitPhone(cropped);
  const nomId = String(nomination.id || nomination._id || "");
  const nomPhoto = String(nomination.photo_url || "").trim();
  const sourcePhoto = String(portrait.source_photo_url || "").trim();
  const isSourceNom = String(portrait.source_nomination_id || "") === nomId;
  const phonesMatch = teacherPhone.length === 10 && teacherPhone === portraitPhone;
  const urlBelongs = !cropped || !urlPhone || urlPhone === portraitPhone;
  const photoConsistent = !nomPhoto || !sourcePhoto || nomPhoto === sourcePhoto || isSourceNom;
  const namesOk = namesCompatible(nomination.teacher_name, portrait.teacher_name);
  const generated = String(portrait.portrait_status || "") === "GENERATED";

  let reason = "ok";
  if (!phonesMatch) reason = "phone_mismatch";
  else if (!urlBelongs) reason = "cloudinary_public_id_mismatch";
  else if (!namesOk) reason = "teacher_name_conflict_on_same_phone";
  else if (!photoConsistent) reason = "nomination_photo_is_not_portrait_source";
  else if (!generated || !cropped) reason = "portrait_not_finalized";

  const usable = reason === "ok";
  const mapping: PortraitMapping = !phonesMatch || !urlBelongs || !namesOk || !photoConsistent ? "MISMATCH" : "MATCH";

  return {
    teacher_phone: teacherPhone,
    portrait_phone: portraitPhone || null,
    mapping,
    usable,
    portrait_cloudinary_url: usable ? cropped : null,
    cropped_local_png_path: usable ? String(portrait.cropped_local_png_path || "").trim() || null : null,
    portrait_id: portrait.id || portrait._id ? String(portrait.id || portrait._id) : null,
    reason,
  };
};
