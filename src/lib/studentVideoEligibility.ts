/** Student-nominated Teacher's Day video eligibility — uses existing Nomination fields. */

export const hasTeacherPhoto = (photoUrl: unknown): boolean => {
  const value = String(photoUrl ?? "").trim();
  return value.length > 0;
};

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
