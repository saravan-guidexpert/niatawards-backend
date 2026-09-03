/** Student-nominated Teacher's Day video eligibility — uses existing Nomination fields. */

import { hasSourcePhoto } from "./sourcePhoto";
import { nominationKind } from "./nominationKind";

export const hasTeacherPhoto = (photoUrl: unknown): boolean => hasSourcePhoto(photoUrl);

export const isSubmittedStudentNomination = (n: {
  type?: unknown;
  status?: unknown;
  student_class?: unknown;
}): boolean => nominationKind(n) === "student" && n.status !== "draft";

/** Photo is optional. Colleague (type=student + Teacher / Colleague) is not a student video. */
export const isEligibleStudentVideo = (n: {
  type?: unknown;
  status?: unknown;
  student_class?: unknown;
  photo_url?: unknown;
}): boolean => isSubmittedStudentNomination(n);
