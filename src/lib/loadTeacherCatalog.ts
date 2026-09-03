import { Nomination } from "../models/Nomination";
import { NominationVideo } from "../models/NominationVideo";
import { TeacherPortrait } from "../models/TeacherPortrait";
import {
  buildCategoryTeachers,
  nominationsByPhone,
  portraitByPhone,
  videoByNomination,
  type CatalogNomination,
  type CatalogPortrait,
  type CatalogVideo,
} from "./teacherPortraitCatalog";
import { activeLiveStatuses } from "./videoGenerationWorker";

export const loadAdminTeacherCatalog = async () => {
  const [nominations, portraits, videos, live] = await Promise.all([
    Nomination.find({ status: { $ne: "draft" } })
      .select("_id type student_class phone teacher_name full_name nominator_name photo_url created_at")
      .lean(),
    TeacherPortrait.find({}).lean(),
    NominationVideo.find({}).select("nomination_id generation_status video_url category_icon_id category_icon_filename").lean(),
    activeLiveStatuses(),
  ]);
  const buckets = buildCategoryTeachers(nominations as CatalogNomination[]);
  const portraitsMap = portraitByPhone(portraits as CatalogPortrait[]);
  const videosMap = videoByNomination(videos as CatalogVideo[]);
  const nomsByPhone = nominationsByPhone(nominations as CatalogNomination[]);
  return { buckets, portraitsMap, videosMap, live, nomsByPhone };
};
