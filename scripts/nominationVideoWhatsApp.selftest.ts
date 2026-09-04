/**
 * Pure-function checks for nomination-video WhatsApp eligibility and template selection.
 * Does not send messages or connect to MongoDB.
 */
import {
  comparePreferredVideos,
  evaluateNominationVideoWhatsAppFromDocs,
  existingVideoDeliveryDecision,
  isNominationVideoWhatsAppKind,
  isWhatsAppTestRecipient,
  teacherKindKey,
  templateEnvKeyForNominationKind,
  VIDEO_MESSAGING_TEST_PHONE,
  whatsappKindForNominationKind,
} from "../src/lib/nominationVideoWhatsApp";

process.env.GUPSHUP_TEMPLATE_STUDENT_NOMINATED_TEACHER = "student-template-id";
process.env.GUPSHUP_TEMPLATE_TEACHER_NOMINATED = "teacher-template-id";
process.env.GUPSHUP_TEMPLATE_TEACHER_NOMINATED_OTHER = "other-template-id";

const assert = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

assert(whatsappKindForNominationKind("student") === "student_nominated_teacher", "student kind");
assert(whatsappKindForNominationKind("teacher") === "teacher_nominated", "teacher kind");
assert(whatsappKindForNominationKind("colleague") === "teacher_nominated_other", "colleague kind");
assert(
  templateEnvKeyForNominationKind("student") === "GUPSHUP_TEMPLATE_STUDENT_NOMINATED_TEACHER",
  "student env key"
);
assert(templateEnvKeyForNominationKind("teacher") === "GUPSHUP_TEMPLATE_TEACHER_NOMINATED", "teacher env key");
assert(
  templateEnvKeyForNominationKind("colleague") === "GUPSHUP_TEMPLATE_TEACHER_NOMINATED_OTHER",
  "colleague env key"
);
assert(isNominationVideoWhatsAppKind("student_nominated_teacher"), "video kind student");
assert(!isNominationVideoWhatsAppKind("student_nominate"), "student_nominate is not a video kind");

assert(existingVideoDeliveryDecision(null, false) === "send", "no existing record can send");
assert(existingVideoDeliveryDecision({ status: "queued" }, true) === "duplicate", "queued is duplicate even with retry");
assert(existingVideoDeliveryDecision({ status: "submitted" }, true) === "duplicate", "submitted is duplicate");
assert(existingVideoDeliveryDecision({ status: "delivered" }, true) === "duplicate", "delivered is duplicate");
assert(existingVideoDeliveryDecision({ status: "failed" }, false) === "duplicate", "failed without retry is blocked");
assert(existingVideoDeliveryDecision({ status: "failed" }, true) === "retry", "failed with retry is allowed");
assert(teacherKindKey("9347763131", "student") === "9347763131:student", "teacher+kind key");
assert(
  comparePreferredVideos(
    { ready_for_message: false, review_status: "ready_for_review", generated_at: "2026-01-01", _id: "a" },
    { ready_for_message: true, review_status: "ready_for_review", generated_at: "2026-01-01", _id: "b" }
  ) > 0,
  "ready_for_message wins video selection"
);
assert(
  comparePreferredVideos(
    { ready_for_message: true, review_status: "ready_for_review", generated_at: "2026-01-02", _id: "older-better-status" },
    { ready_for_message: false, review_status: "approved", generated_at: "2026-06-01", _id: "newer" }
  ) < 0,
  "ready_for_message still beats later unapproved video"
);
assert(isWhatsAppTestRecipient(VIDEO_MESSAGING_TEST_PHONE), "authorized test phone");
assert(
  existingVideoDeliveryDecision({ status: "delivered", phone: VIDEO_MESSAGING_TEST_PHONE }, false) === "retry",
  "test number can resend after delivered"
);
assert(
  existingVideoDeliveryDecision({ status: "read", phone: VIDEO_MESSAGING_TEST_PHONE }, false) === "retry",
  "test number can resend after read"
);
assert(
  existingVideoDeliveryDecision({ status: "queued", phone: VIDEO_MESSAGING_TEST_PHONE }, false) === "duplicate",
  "test number still cannot double-send while queued"
);
assert(
  existingVideoDeliveryDecision({ status: "delivered", phone: "9483204012" }, false) === "duplicate",
  "production delivered numbers cannot resend"
);

const studentNom = {
  _id: "nom-student",
  type: "student",
  student_class: "10",
  phone: "9347763131",
  nominator_phone: "9999999999",
  teacher_name: "Teacher A",
  photo_url: null,
  status: "pending",
};

const studentVideo = {
  _id: "vid-student",
  nomination_id: "nom-student",
  generation_status: "generated",
  video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/nom-student/r1.mp4",
  ready_for_message: true,
  nomination_kind: "student",
  video_template: "student-nominated",
  photo_used: false,
  video_category: "without_photo",
};

const okStudent = evaluateNominationVideoWhatsAppFromDocs({ nomination: studentNom, video: studentVideo });
assert(okStudent.ok, "eligible student video should pass");
if (okStudent.ok) {
  assert(okStudent.value.teacherPhone === "9347763131", "destination must be teacher phone");
  assert(okStudent.value.teacherPhone !== "9999999999", "must not use nominator phone");
  assert(okStudent.value.templateEnvKey === "GUPSHUP_TEMPLATE_STUDENT_NOMINATED_TEACHER", "student template env");
  assert(okStudent.value.videoUrl === studentVideo.video_url, "uses Cloudinary URL from the video");
}

const afterSession = evaluateNominationVideoWhatsAppFromDocs({
  nomination: studentNom,
  video: studentVideo,
  fromAfterSession: true,
});
assert(!afterSession.ok && afterSession.reason === "after_session_excluded", "AfterSessionNomination is excluded");

const draftNom = evaluateNominationVideoWhatsAppFromDocs({
  nomination: { ...studentNom, status: "draft" },
  video: studentVideo,
});
assert(!draftNom.ok && draftNom.reason === "nomination_draft", "draft nominations must not send");

assert(
  evaluateNominationVideoWhatsAppFromDocs({ nomination: null, video: studentVideo }).reason === "nomination_not_found",
  "missing nomination"
);

const colleagueNom = {
  _id: "nom-colleague",
  type: "student",
  student_class: "Teacher / Colleague",
  phone: "9347763131",
  nominator_phone: "8888888888",
  teacher_name: "Colleague Teacher",
  photo_url: null,
  status: "pending",
};
const colleagueVideo = {
  _id: "vid-colleague",
  nomination_id: "nom-colleague",
  generation_status: "generated",
  video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/nom-colleague/r2.mp4",
  ready_for_message: true,
  nomination_kind: "colleague",
  video_template: "teacher-nominated-teacher",
  photo_used: false,
  video_category: "without_photo",
};
const okColleague = evaluateNominationVideoWhatsAppFromDocs({ nomination: colleagueNom, video: colleagueVideo });
assert(okColleague.ok, "colleague nomination should use other-teacher template");
if (okColleague.ok) {
  assert(okColleague.value.nominationKind === "colleague", "preserve colleague classification");
  assert(okColleague.value.templateEnvKey === "GUPSHUP_TEMPLATE_TEACHER_NOMINATED_OTHER", "other template");
  assert(okColleague.value.teacherPhone === "9347763131", "colleague destination is teacher phone, not nominator");
}

const unlabeledColleague = evaluateNominationVideoWhatsAppFromDocs({
  nomination: colleagueNom,
  video: {
    ...colleagueVideo,
    nomination_kind: null,
    video_template: null,
  },
});
assert(
  !unlabeledColleague.ok && unlabeledColleague.reason === "video_category_mismatch",
  "legacy unlabeled colleague videos must not send"
);

const generatedUnapproved = evaluateNominationVideoWhatsAppFromDocs({
  nomination: studentNom,
  video: { ...studentVideo, ready_for_message: false, review_status: "ready_for_review" },
});
assert(generatedUnapproved.ok, "generated videos are sendable without ready_for_message");

const blockedReview = evaluateNominationVideoWhatsAppFromDocs({
  nomination: studentNom,
  video: { ...studentVideo, ready_for_message: false, review_status: "rejected" },
});
assert(!blockedReview.ok && blockedReview.reason === "review_blocked", "rejected videos must not send");

const wrongNom = evaluateNominationVideoWhatsAppFromDocs({
  nomination: studentNom,
  video: { ...studentVideo, nomination_id: "other-nom" },
});
assert(!wrongNom.ok && wrongNom.reason === "video_nomination_mismatch", "video must belong to the nomination");

const teacherNom = {
  _id: "nom-teacher",
  type: "teacher",
  student_class: null,
  phone: "9347763131",
  nominator_phone: "7777777777",
  full_name: "Self Teacher",
  photo_url: null,
  status: "pending",
};
const teacherVideo = {
  _id: "vid-teacher",
  nomination_id: "nom-teacher",
  generation_status: "generated",
  video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/nom-teacher/r3.mp4",
  ready_for_message: true,
  nomination_kind: "teacher",
  video_template: "teacher-nominated-teacher",
  photo_used: false,
  video_category: "without_photo",
};
const okTeacher = evaluateNominationVideoWhatsAppFromDocs({ nomination: teacherNom, video: teacherVideo });
assert(okTeacher.ok, "teacher-nominated video should pass");
if (okTeacher.ok) {
  assert(okTeacher.value.templateEnvKey === "GUPSHUP_TEMPLATE_TEACHER_NOMINATED", "teacher template env");
}

console.log("nominationVideoWhatsApp.selftest ok");
