import {
  videoIdentityMismatch,
  videoProductionValid,
  videoSatisfiesNomination,
} from "../src/lib/videoIdentity";

const studentVideo = {
  nomination_id: "n1",
  generation_status: "generated",
  video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/n1/r1.mp4",
  video_template: "student-nominated" as const,
  nomination_kind: "student" as const,
};

const assert = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

assert(
  videoSatisfiesNomination({ video: studentVideo, nominationId: "n1", expectedKind: "student" }),
  "student video should satisfy its nomination"
);
assert(
  !videoSatisfiesNomination({ video: studentVideo, nominationId: "n1", expectedKind: "colleague" }),
  "student video must not satisfy a colleague nomination"
);
assert(
  videoIdentityMismatch({
    video: {
      nomination_id: "n3",
      generation_status: "generated",
      video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/n1/r1.mp4",
    },
    nominationId: "n3",
    expectedKind: "colleague",
  }) === "path_nomination_mismatch",
  "Cloudinary path from another nomination must be rejected"
);
assert(
  videoIdentityMismatch({
    video: {
      nomination_id: "n3",
      generation_status: "generated",
      video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/n3/r2.mp4",
    },
    nominationId: "n3",
    expectedKind: "colleague",
  }) === "legacy_unlabeled_non_student",
  "unlabeled colleague videos from the student bulk must not count as generated"
);
assert(
  videoSatisfiesNomination({
    video: {
      nomination_id: "n3",
      generation_status: "generated",
      video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/n3/r2.mp4",
      nomination_kind: "colleague",
      video_template: "teacher-nominated-teacher",
    },
    nominationId: "n3",
    expectedKind: "colleague",
  }),
  "labeled colleague video should satisfy"
);
assert(
  videoSatisfiesNomination({
    video: {
      nomination_id: "n2",
      generation_status: "generated",
      video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/n2/r3.mp4",
    },
    nominationId: "n2",
    expectedKind: "teacher",
  }),
  "unlabeled teacher-self videos are accepted because they were never in the student bulk"
);

assert(
  !videoProductionValid({
    video: {
      ...studentVideo,
      photo_used: false,
      video_category: "without_photo",
    },
    nominationId: "n1",
    expectedKind: "student",
    expectedPhoto: "with_photo",
  }),
  "with-photo nomination playing a without-photo MP4 is INVALID"
);
assert(
  videoProductionValid({
    video: {
      ...studentVideo,
      photo_used: true,
      video_category: "with_photo",
    },
    nominationId: "n1",
    expectedKind: "student",
    expectedPhoto: "with_photo",
  }),
  "with-photo nomination with photo_used and video_category with_photo is VALID"
);
assert(
  videoProductionValid({
    video: {
      ...studentVideo,
      photo_used: false,
      video_category: "without_photo",
    },
    nominationId: "n1",
    expectedKind: "student",
    expectedPhoto: "without_photo",
  }),
  "without-photo nomination with a no-photo MP4 is VALID"
);

console.log("videoIdentity selftest passed");
