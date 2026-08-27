import { maskPhone, toPhone10 } from "./gupshup";
import { sendWhatsApp } from "./whatsappSend";

export const TEACHER_SUBMIT_WHATSAPP_KIND = "teacher_submit";

export const TEACHER_SUBMIT_POSTER_URL =
  "https://res.cloudinary.com/dfqdb1xws/image/upload/v1787836370/WhatsApp_Image_2026-08-27_at_5.35.22_PM_1_venn7v.jpg";

type TeacherSubmitNomination = {
  type?: string | null;
  phone?: string | null;
  full_name?: string | null;
  nominator_name?: string | null;
  teacher_name?: string | null;
};

const teacherDisplayName = (nomination: TeacherSubmitNomination) => {
  const name = String(
    nomination.full_name || nomination.nominator_name || nomination.teacher_name || ""
  ).trim();
  return name || "Teacher";
};

/** Sends the teacher-submit template. Failures are logged; they never throw. */
export const notifyTeacherOnSubmit = async (nomination: TeacherSubmitNomination | null | undefined) => {
  if (!nomination || nomination.type !== "teacher") return;
  const phone = toPhone10(nomination.phone || "");
  if (!/^\d{10}$/.test(phone)) return;

  const name = teacherDisplayName(nomination);
  try {
    const result = await sendWhatsApp({
      kind: TEACHER_SUBMIT_WHATSAPP_KIND,
      phone,
      params: [name],
      source: "api",
      headerImageUrl: TEACHER_SUBMIT_POSTER_URL,
    });
    if (!result.success) {
      console.error("[WhatsApp] teacher_submit failed", maskPhone(phone), result.error);
      return;
    }
    console.log("[WhatsApp] teacher_submit submitted", maskPhone(phone), result.eventId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[WhatsApp] teacher_submit exception", maskPhone(phone), message);
  }
};
