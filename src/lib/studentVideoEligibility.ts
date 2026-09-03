/** Student-nominated Teacher's Day video eligibility — uses existing Nomination fields. */

import { hasSourcePhoto } from "./sourcePhoto";

export const hasTeacherPhoto = (photoUrl: unknown): boolean => hasSourcePhoto(photoUrl);

export const isSubmittedStudentNomination = (n: {
  type?: unknown;
  status?: unknown;
}): boolean => n.type === "student" && n.status !== "draft";

/** Photo is optional. Eligibility is submitted student nominations only. */
export const isEligibleStudentVideo = (n: {
  type?: unknown;
  status?: unknown;
  photo_url?: unknown;
}): boolean => isSubmittedStudentNomination(n);
