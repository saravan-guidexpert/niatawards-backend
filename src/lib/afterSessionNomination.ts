import type { AfterSessionNomination } from "../models/AfterSessionNomination";

export const DRAFT_FIELDS = [
  "student_name",
  "student_class",
  "class_group",
  "school_name",
  "phone",
  "teacher_name",
  "award_category",
  "special_thing",
  "subject",
  "impact_story",
  "board",
  "teacher_social",
  "full_name",
  "experience",
  "email",
] as const;

const KNOWN_BODY_KEYS = new Set([
  ...DRAFT_FIELDS,
  "type",
  "nominator_name",
  "nominator_phone",
  "photo_url",
  "care_rating",
  "clarity_rating",
  "motivation_rating",
  "support_rating",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "draft_token",
  "form_step",
  "complete",
  "resume",
  "source_form",
  "phone_verified",
  "status",
]);

const STRIP_FROM_RAW = new Set(["otp", "password", "token", "admin_secret", "draft_token"]);

export const TEACHER_COLLEAGUE_CLASS = "Teacher / Colleague";

export const cleanPhone = (phone: unknown) => String(phone ?? "").replace(/\D/g, "").slice(-10);
export const TEACHER_PHONE_SAME_AS_STUDENT_MSG = "Please enter your nominating teacher's number";

export const assertTeacherPhoneNotNominator = (type: string, teacherPhone: string, nominatorPhone: string) => {
  if (type !== "student") return;
  if (teacherPhone.length === 10 && nominatorPhone.length === 10 && teacherPhone === nominatorPhone) {
    throw new Error(TEACHER_PHONE_SAME_AS_STUDENT_MSG);
  }
};

export const sanitizePhotoUrl = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("photo_url must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("photo_url is not a valid URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isCloudinary =
    parsed.protocol === "https:" &&
    (host === "res.cloudinary.com" || host.endsWith(".cloudinary.com"));
  if (!isCloudinary) {
    throw new Error("photo_url must be a Cloudinary URL");
  }
  return trimmed;
};

export const sanitizeUtm = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 256);
  return trimmed || null;
};

export const utmFromBody = (body: Record<string, unknown>) => ({
  utm_source: sanitizeUtm(body.utm_source),
  utm_medium: sanitizeUtm(body.utm_medium),
  utm_campaign: sanitizeUtm(body.utm_campaign),
  utm_term: sanitizeUtm(body.utm_term),
  utm_content: sanitizeUtm(body.utm_content),
});

export const sanitizeEmail = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  const trimmed = String(value).trim().slice(0, 320);
  return trimmed || null;
};

export const extraFieldsFromBody = (body: Record<string, unknown>) => {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (KNOWN_BODY_KEYS.has(key)) continue;
    if (STRIP_FROM_RAW.has(key)) continue;
    extra[key] = value;
  }
  return extra;
};

export const rawPayloadFromBody = (body: Record<string, unknown>) => {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (STRIP_FROM_RAW.has(key)) continue;
    raw[key] = value;
  }
  return raw;
};

export const mergeRawPayload = (
  existing: Record<string, unknown> | undefined,
  body: Record<string, unknown>
) => ({
  ...(existing && typeof existing === "object" ? existing : {}),
  ...rawPayloadFromBody(body),
  _last_received_at: new Date().toISOString(),
});

export const formKindOf = (doc: {
  type?: string | null;
  student_class?: string | null;
}) => {
  if (doc.type === "teacher") return "teacher_self";
  if (String(doc.student_class || "").trim() === TEACHER_COLLEAGUE_CLASS) return "teacher_other";
  return "student";
};

type AfterSessionDoc = InstanceType<typeof AfterSessionNomination>;

export const applyDraftFields = (draft: AfterSessionDoc, body: Record<string, unknown>) => {
  for (const field of DRAFT_FIELDS) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (field === "phone") {
      const cleaned = cleanPhone(value);
      if (cleaned.length === 10) {
        assertTeacherPhoneNotNominator(draft.type, cleaned, cleanPhone(draft.nominator_phone));
        draft.phone = cleaned;
      }
      continue;
    }
    if (field === "email") {
      draft.email = sanitizeEmail(value);
      continue;
    }
    if (value == null || value === "") {
      (draft as unknown as Record<string, unknown>)[field] = null;
      continue;
    }
    (draft as unknown as Record<string, unknown>)[field] = String(value).trim();
  }

  if (body.photo_url !== undefined) {
    draft.photo_url = sanitizePhotoUrl(body.photo_url);
  }

  if (body.nominator_name !== undefined) {
    const name = String(body.nominator_name ?? "").trim();
    if (name) draft.nominator_name = name;
  }

  for (const rating of ["care_rating", "clarity_rating", "motivation_rating", "support_rating"] as const) {
    if (body[rating] === undefined) continue;
    const num = Number(body[rating]);
    (draft as unknown as Record<string, unknown>)[rating] = Number.isFinite(num) ? num : null;
  }

  const utm = utmFromBody(body);
  for (const [key, value] of Object.entries(utm)) {
    if (body[key] !== undefined) {
      (draft as unknown as Record<string, unknown>)[key] = value;
    }
  }

  const extra = extraFieldsFromBody(body);
  if (Object.keys(extra).length > 0) {
    draft.extra_fields = {
      ...(draft.extra_fields && typeof draft.extra_fields === "object" ? draft.extra_fields : {}),
      ...extra,
    };
  }

  draft.raw_payload = mergeRawPayload(
    draft.raw_payload && typeof draft.raw_payload === "object" ? (draft.raw_payload as Record<string, unknown>) : {},
    body
  );
};

export const requireCompleteFields = (draft: AfterSessionDoc) => {
  if (draft.type === "student") {
    if (!draft.student_name?.trim()) throw new Error("Please enter your name");
    if (!draft.student_class?.trim()) throw new Error("Please select your current education");
    if (!draft.school_name?.trim()) throw new Error("Please enter school / college name");
    if (!draft.teacher_name?.trim()) throw new Error("Please enter the teacher's full name");
    if (cleanPhone(draft.phone).length !== 10) throw new Error("Please enter a valid teacher phone number");
    assertTeacherPhoneNotNominator(draft.type, cleanPhone(draft.phone), cleanPhone(draft.nominator_phone));
    if (!draft.special_thing?.trim()) throw new Error("Please fill in what's special about this teacher");
    return;
  }
  if (!draft.full_name?.trim()) throw new Error("Please enter your name");
  if (!draft.school_name?.trim()) throw new Error("Please enter school / college name");
  if (cleanPhone(draft.phone).length !== 10) throw new Error("Please enter a valid phone number");
  if (!draft.subject?.trim()) throw new Error("Please enter your subject");
  if (!draft.experience?.trim()) throw new Error("Please enter years of experience");
  if (!draft.student_class?.trim()) throw new Error("Please select which class you teach");
  if (!draft.impact_story?.trim()) throw new Error("Please share your impact story");
};

/** Public form API shape — compatible with the previous Nomination draft responses. */
export const toClientJson = (doc: AfterSessionDoc) => {
  const json = doc.toJSON() as Record<string, unknown>;
  return {
    ...json,
    status: doc.lifecycle === "submitted" ? "pending" : "draft",
    form_kind: formKindOf(doc),
  };
};

export const draftPayload = (doc: AfterSessionDoc) => ({
  ...toClientJson(doc),
  draft_token: doc.draft_token,
});

export const toAdminJson = (doc: unknown) => {
  const source = doc as {
    toJSON?: () => Record<string, unknown>;
    _id?: unknown;
    __v?: unknown;
    draft_token?: unknown;
  } & Record<string, unknown>;
  const raw: Record<string, unknown> =
    typeof source.toJSON === "function"
      ? source.toJSON()
      : (() => {
          const { _id, __v, draft_token, ...rest } = source;
          return { ...rest, id: _id };
        })();
  const { admin_status, lifecycle, ...rest } = raw;
  return {
    ...rest,
    lifecycle,
    status: admin_status || "NEW",
    form_kind: formKindOf({
      type: String(raw.type || ""),
      student_class: raw.student_class == null ? null : String(raw.student_class),
    }),
    has_photo: Boolean(raw.photo_url),
    nominee_name:
      raw.type === "teacher"
        ? raw.full_name || raw.nominator_name || null
        : raw.teacher_name || null,
    nominee_phone: raw.phone || null,
    nominator_display_name: raw.nominator_name || raw.student_name || raw.full_name || null,
    nominator_display_phone: raw.nominator_phone || null,
  };
};
