import { Router, Request, Response } from "express";
import { Nomination } from "../models/Nomination";
import { NominationVideo } from "../models/NominationVideo";
import { TeacherPortrait } from "../models/TeacherPortrait";
import {
  isEligibleStudentVideo,
  isSubmittedStudentNomination,
} from "../lib/studentVideoEligibility";
import { loadPortraitReview } from "../lib/teacherPortrait";
import { phone10, resolveTeacherPortrait } from "../lib/resolveTeacherPortrait";
import { hasSourcePhoto, intendedVideoCategory } from "../lib/sourcePhoto";
import { isSubmittedNomination, nominationKind, photoStateOf } from "../lib/nominationKind";

const router = Router();

const mapTeacherPortraitStatus = (status: unknown, photoProvided: boolean) => {
  if (!photoProvided) return "NOT_PROVIDED";
  const value = String(status || "");
  if (value === "GENERATED") return "READY";
  if (value === "PENDING") return "NOT_STARTED";
  if (value === "PROCESSING" || value === "NEEDS_REVIEW" || value === "FAILED" || value === "NOT_PROVIDED") {
    return value;
  }
  return null;
};

const hasPlayableVideo = (url: unknown) => {
  const value = String(url ?? "").trim();
  return /^https?:\/\//i.test(value);
};

const toReviewItem = (
  nomination: Record<string, unknown>,
  video: Record<string, unknown> | null,
  teacherPortrait: Record<string, unknown> | null
) => {
  const eligible = isEligibleStudentVideo(nomination);
  const photoProvided = hasSourcePhoto(nomination.photo_url);
  const intendedCategory = intendedVideoCategory(nomination.photo_url);
  const videoUrl = video?.video_url ?? null;
  const generationStatus = eligible
    ? String(video?.generation_status || "pending")
    : "not_eligible";
  const reviewStatus = eligible ? String(video?.review_status || "none") : "not_eligible";
  const localPortrait = loadPortraitReview(String(nomination.id), photoProvided);
  const resolved = resolveTeacherPortrait(nomination, teacherPortrait);
  const cloudinaryUrl = resolved.usable ? resolved.portrait_cloudinary_url || "" : "";
  const mapped = mapTeacherPortraitStatus(
    teacherPortrait?.portrait_status,
    photoProvided
  );

  const renderedCategory =
    video?.video_category === "with_photo" || video?.video_category === "without_photo"
      ? String(video.video_category)
      : null;
  const photoUsedInVideo = Boolean(video?.photo_used);
  const categoryMismatch = photoProvided && (renderedCategory === "without_photo" || video?.photo_used === false);

  return {
    nomination_id: nomination.id,
    teacher_name: nomination.teacher_name || null,
    teacher_phone: resolved.teacher_phone || nomination.phone || null,
    portrait_phone: resolved.portrait_phone,
    portrait_mapping: resolved.mapping,
    portrait_mapping_reason: resolved.reason,
    teacher_photo_url: photoProvided ? nomination.photo_url : null,
    teacher_photo_provided: photoProvided,
    has_source_photo: photoProvided,
    video_category: intendedCategory,
    rendered_video_category: renderedCategory,
    photo_used: photoUsedInVideo,
    category_mismatch: Boolean(categoryMismatch),
    student_name: nomination.student_name || null,
    nominator_name: nomination.nominator_name || null,
    nominator_phone: nomination.nominator_phone || null,
    nomination_type: nomination.type,
    nomination_kind: nominationKind(nomination),
    photo_state: photoStateOf(nomination.photo_url),
    student_class: nomination.student_class || null,
    created_at: nomination.created_at || null,
    eligible,
    generation_status: generationStatus,
    review_status: reviewStatus,
    video_url: hasPlayableVideo(videoUrl) ? videoUrl : null,
    video_render_id: video?.video_render_id ? String(video.video_render_id) : null,
    category_icon_id: video?.category_icon_id ? String(video.category_icon_id) : null,
    category_icon_filename: video?.category_icon_filename ? String(video.category_icon_filename) : null,
    audio_filename: video?.audio_filename ? String(video.audio_filename) : null,
    generated_at: video?.generated_at || null,
    approved_at: video?.approved_at || null,
    rejected_at: video?.rejected_at || null,
    rejection_reason: video?.rejection_reason || null,
    ready_for_message: Boolean(video?.ready_for_message),
    regenerate_available: false,
    portrait_status: !photoProvided
      ? "NOT_PROVIDED"
      : resolved.usable
        ? "READY"
        : resolved.mapping === "MISMATCH"
          ? "NEEDS_REVIEW"
          : mapped === "NOT_PROVIDED"
            ? "NOT_STARTED"
            : mapped || localPortrait.portrait_status,
    portrait_url: cloudinaryUrl || null,
    portrait_preview_url: localPortrait.portrait_preview_url,
    portrait_report: localPortrait.portrait_report,
  };
};

const filterKey = (item: ReturnType<typeof toReviewItem>) => {
  if (!item.eligible) return "not_eligible";
  if (item.generation_status === "failed") return "failed";
  if (item.review_status === "ready_for_review" && item.video_url) return "ready_for_review";
  if (item.review_status === "approved") return "approved";
  if (item.review_status === "rejected") return "rejected";
  if (item.review_status === "regeneration_required") return "regeneration_required";
  return "pending";
};

router.get("/", async (_req: Request, res: Response) => {
  try {
    const nominations = await Nomination.find({
      status: { $ne: "draft" },
    }).sort({ created_at: -1 });

    const jsons = nominations.map((n) => n.toJSON() as Record<string, unknown>);
    const ids = jsons.map((n) => String(n.id));
    const phones = [
      ...new Set(jsons.map((n) => phone10(n.phone)).filter((p) => p.length === 10)),
    ];
    const videos = await NominationVideo.find({ nomination_id: { $in: ids } });
    const portraits = await TeacherPortrait.find({ teacher_phone: { $in: phones } });
    const videoByNomination = new Map(
      videos.map((v) => [v.nomination_id, v.toJSON() as Record<string, unknown>])
    );
    const portraitByPhone = new Map(
      portraits.map((p) => [p.teacher_phone, p.toJSON() as Record<string, unknown>])
    );

    const items = jsons
      .filter((n) => isSubmittedNomination(n))
      .map((n) =>
        toReviewItem(
          n,
          videoByNomination.get(String(n.id)) || null,
          portraitByPhone.get(phone10(n.phone)) || null
        )
      );

    const counts = {
      total: items.length,
      with_photo: items.filter((i) => i.video_category === "with_photo").length,
      without_photo: items.filter((i) => i.video_category === "without_photo").length,
      needs_with_photo_regen: items.filter((i) => i.category_mismatch).length,
      ready_for_review: items.filter((i) => filterKey(i) === "ready_for_review").length,
      approved: items.filter((i) => filterKey(i) === "approved").length,
      rejected: items.filter((i) => filterKey(i) === "rejected").length,
      failed: items.filter((i) => filterKey(i) === "failed").length,
      student_with_photo: items.filter((i) => i.nomination_kind === "student" && i.photo_state === "with_photo").length,
      student_without_photo: items.filter((i) => i.nomination_kind === "student" && i.photo_state === "without_photo").length,
      teacher_with_photo: items.filter((i) => i.nomination_kind === "teacher" && i.photo_state === "with_photo").length,
      teacher_without_photo: items.filter((i) => i.nomination_kind === "teacher" && i.photo_state === "without_photo").length,
      colleague_with_photo: items.filter((i) => i.nomination_kind === "colleague" && i.photo_state === "with_photo").length,
      colleague_without_photo: items.filter((i) => i.nomination_kind === "colleague" && i.photo_state === "without_photo").length,
    };

    res.json({ items, counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load video reviews";
    res.status(500).json({ error: message });
  }
});

router.patch("/:nominationId", async (req: Request, res: Response) => {
  try {
    const nominationId = String(req.params.nominationId || "").trim();
    const action = String(req.body?.action || "").trim();
    const nomination = await Nomination.findById(nominationId);

    if (!nomination || !isSubmittedStudentNomination(nomination)) {
      res.status(404).json({ error: "Nomination not found" });
      return;
    }
    if (!isEligibleStudentVideo(nomination)) {
      res.status(400).json({ error: "Only submitted student nominations can be reviewed" });
      return;
    }

    let video = await NominationVideo.findOne({ nomination_id: nominationId });
    const playable = hasPlayableVideo(video?.video_url);

    if (action === "approve") {
      if (!video || !playable || video.generation_status !== "generated") {
        res.status(400).json({ error: "No generated video to approve yet" });
        return;
      }
      if (video.review_status !== "ready_for_review" && video.review_status !== "regeneration_required") {
        res.status(400).json({ error: "This video is not waiting for review" });
        return;
      }
      video.review_status = "approved";
      video.approved_at = new Date();
      video.rejected_at = null;
      video.rejection_reason = null;
      video.ready_for_message = true;
      video.reviewed_by = req.admin?.id || null;
      await video.save();
    } else if (action === "reject") {
      const reason = String(req.body?.reason ?? "").trim();
      if (!reason) {
        res.status(400).json({ error: "A rejection reason is required" });
        return;
      }
      if (!video || !playable) {
        res.status(400).json({ error: "No generated video to reject yet" });
        return;
      }
      if (video.review_status !== "ready_for_review" && video.review_status !== "regeneration_required") {
        res.status(400).json({ error: "This video is not waiting for review" });
        return;
      }
      video.review_status = "rejected";
      video.rejected_at = new Date();
      video.rejection_reason = reason.slice(0, 500);
      video.ready_for_message = false;
      video.reviewed_by = req.admin?.id || null;
      await video.save();
    } else {
      res.status(400).json({ error: "action must be approve or reject" });
      return;
    }

    const portrait = await TeacherPortrait.findOne({ teacher_phone: phone10(nomination.phone) });
    res.json(
      toReviewItem(
        nomination.toJSON() as Record<string, unknown>,
        video.toJSON() as Record<string, unknown>,
        portrait ? (portrait.toJSON() as Record<string, unknown>) : null
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update video review";
    res.status(500).json({ error: message });
  }
});

export default router;
