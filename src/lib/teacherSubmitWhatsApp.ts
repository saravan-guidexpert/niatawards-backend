import { WhatsAppMessageEvent } from "../models/WhatsAppMessageEvent";
import { maskPhone, toPhone10 } from "./gupshup";
import { sendWhatsApp } from "./whatsappSend";

/** New sends use this kind. The Gupshup template id still lives in GUPSHUP_TEMPLATE_TEACHER_SUBMIT. */
export const STUDENT_NOMINATE_WHATSAPP_KIND = "student_nominate";
/** Legacy kind from when this template was wired to teacher self-nomination. */
export const TEACHER_SUBMIT_WHATSAPP_KIND = "teacher_submit";

export const TEACHER_SUBMIT_POSTER_URL =
  "https://res.cloudinary.com/dfqdb1xws/image/upload/v1787836370/WhatsApp_Image_2026-08-27_at_5.35.22_PM_1_venn7v.jpg";

export const TEACHER_SUBMIT_REFERRAL_URL =
  "https://www.niatawards.in/?utm_source=whatsapp&utm_medium=referral_link&utm_campaign=guru_ratna_2026&utm_content=Referral+link";

const normalizeKind = (kind: string) =>
  String(kind || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_|_$/g, "");

export const isStudentNominateKind = (kind: string) => {
  const normalized = normalizeKind(kind);
  return normalized === STUDENT_NOMINATE_WHATSAPP_KIND || normalized === TEACHER_SUBMIT_WHATSAPP_KIND;
};

/** {{1}} student name, {{2}} share/referral link. */
export const studentNominateTemplateParams = (name: string) => {
  const display = String(name || "").trim() || "Student";
  return [display, TEACHER_SUBMIT_REFERRAL_URL];
};

export const teacherSubmitTemplateParams = studentNominateTemplateParams;

export const ensureTeacherSubmitParams = (kind: string, params: string[] = []) => {
  if (!isStudentNominateKind(kind)) return params;
  return studentNominateTemplateParams(params[0] || "Student");
};

type StudentNominateNomination = {
  type?: string | null;
  phone?: string | null;
  nominator_phone?: string | null;
  student_name?: string | null;
  nominator_name?: string | null;
};

const studentDisplayName = (nomination: StudentNominateNomination) => {
  const name = String(nomination.student_name || nomination.nominator_name || "").trim();
  return name || "Student";
};

const studentPhone = (nomination: StudentNominateNomination) =>
  toPhone10(nomination.nominator_phone || "");

export type TeacherWhatsAppStatus = {
  status: string;
  attemptNumber: number;
  error: string | null;
};

/** Latest student-nominate attempt per 10-digit phone, for the admin nominations list. */
export const latestTeacherSubmitStatusByPhones = async (phones?: string[]) => {
  const wanted = phones
    ? new Set(phones.map((p) => toPhone10(p)).filter((p) => /^\d{10}$/.test(p)))
    : null;
  const out = new Map<string, TeacherWhatsAppStatus>();
  if (wanted && wanted.size === 0) return out;

  const kinds = [STUDENT_NOMINATE_WHATSAPP_KIND, TEACHER_SUBMIT_WHATSAPP_KIND];
  // Group latest-per-phone for these kinds instead of `$in` over thousands of
  // numbers, which cannot use the phone index and timed the admin list out.
  const rows = await WhatsAppMessageEvent.aggregate<{
    _id: string;
    status: string;
    attemptNumber: number;
    errorMessage: string | null;
  }>([
    { $match: { messageKind: { $in: kinds } } },
    { $sort: { createdAt: -1, attemptNumber: -1 } },
    {
      $group: {
        _id: "$phone",
        status: { $first: "$status" },
        attemptNumber: { $first: "$attemptNumber" },
        errorMessage: { $first: "$errorMessage" },
      },
    },
  ]).option({ allowDiskUse: true, maxTimeMS: 4000 });

  for (const row of rows) {
    const phone = String(row._id || "");
    if (!phone || (wanted && !wanted.has(phone))) continue;
    out.set(phone, {
      status: String(row.status || "queued"),
      attemptNumber: Number(row.attemptNumber || 1),
      error: row.errorMessage ? String(row.errorMessage) : null,
    });
  }
  return out;
};

/** Sends the student-nominate template immediately. Failures retry via the send pipeline. Never throws. */
export const notifyStudentOnNominate = async (nomination: StudentNominateNomination | null | undefined) => {
  if (!nomination || nomination.type !== "student") return;
  const phone = studentPhone(nomination);
  if (!/^\d{10}$/.test(phone)) return;

  const name = studentDisplayName(nomination);
  try {
    const first = await sendWhatsApp({
      kind: STUDENT_NOMINATE_WHATSAPP_KIND,
      phone,
      params: studentNominateTemplateParams(name),
      source: "api",
      headerImageUrl: TEACHER_SUBMIT_POSTER_URL,
      attemptNumber: 1,
    });
    if (first.success) {
      console.log("[WhatsApp] student_nominate submitted", maskPhone(phone), first.eventId);
      return;
    }
    console.error("[WhatsApp] student_nominate failed", maskPhone(phone), first.error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[WhatsApp] student_nominate exception", maskPhone(phone), message);
  }
};

export const notifyTeacherOnSubmit = notifyStudentOnNominate;
