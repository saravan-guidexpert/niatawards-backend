import {
  isVerifiedProductionCrop,
  mapPortraitAdminStatus,
} from "../src/lib/nominationKind";
import { videoProductionValidity } from "../src/lib/videoIdentity";

const assert = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

const playable = {
  nomination_id: "n1",
  generation_status: "generated",
  video_url: "https://res.cloudinary.com/demo/video/upload/niat-awards/teacher-videos/n1/r1.mp4",
  video_template: "student-nominated" as const,
  nomination_kind: "student" as const,
};

assert(
  videoProductionValidity({
    video: { ...playable, photo_used: false, video_category: "without_photo" },
    nominationId: "n1",
    expectedKind: "student",
    expectedPhoto: "with_photo",
  }) === "INVALID",
  "source photo + without-photo MP4 is INVALID"
);

assert(
  videoProductionValidity({
    video: null,
    nominationId: "n1",
    expectedKind: "student",
    expectedPhoto: "with_photo",
  }) === "MISSING",
  "no video record is MISSING"
);

assert(
  videoProductionValidity({
    video: { ...playable, photo_used: true, video_category: "with_photo" },
    nominationId: "n1",
    expectedKind: "student",
    expectedPhoto: "with_photo",
  }) === "VALID",
  "matching with-photo video is VALID"
);

assert(
  !isVerifiedProductionCrop({
    portrait_status: "GENERATED",
    cropped_cloudinary_url: "https://res.cloudinary.com/demo/image/upload/niat-awards/teacher-portraits/9189609700.png",
  }),
  "phone.png without crop_version is not a verified production crop"
);

assert(
  isVerifiedProductionCrop({
    portrait_status: "GENERATED",
    cropped_cloudinary_url: "https://res.cloudinary.com/demo/image/upload/niat-awards/teacher-portraits/9189609700-top60.png",
    crop_version: "top60_y1372",
  }),
  "-top60 URL is a verified production crop"
);

assert(
  mapPortraitAdminStatus(
    {
      portrait_status: "GENERATED",
      cropped_cloudinary_url: "https://res.cloudinary.com/demo/image/upload/niat-awards/teacher-portraits/9189609700.png",
    },
    "with_photo"
  ) === "NEEDS_VERIFICATION",
  "unverified crop is NEEDS_VERIFICATION, not GENERATED"
);

assert(
  mapPortraitAdminStatus(
    {
      portrait_status: "GENERATED",
      cropped_cloudinary_url: "https://res.cloudinary.com/demo/image/upload/niat-awards/teacher-portraits/9189609700-top60.png",
      crop_version: "top60_y1372",
    },
    "with_photo"
  ) === "GENERATED",
  "verified crop is GENERATED"
);

assert(
  videoProductionValidity({
    video: {
      ...playable,
      photo_used: false,
      video_category: "without_photo",
      production_photo_fallback: true,
    },
    nominationId: "n1",
    expectedKind: "student",
    expectedPhoto: "with_photo",
  }) === "VALID",
  "without-photo fallback is VALID for a with-photo nomination"
);

console.log("productionValidity selftest passed");
