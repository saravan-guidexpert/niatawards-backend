import { Router, Request, Response } from "express";
import { Nomination } from "../models/Nomination";
import { NominationVideo } from "../models/NominationVideo";
import {
  hasTeacherPhoto,
  isEligibleStudentVideo,
  isSubmittedStudentNomination,
} from "../lib/studentVideoEligibility";

const router = Router();

const hasPlayableVideo = (url: unknown) => {
  const value = String(url ?? "").trim();
  return /^https?:\/\//i.test(value);
};

const toReviewItem = (
  nomination: Record<string, unknown>,
  video: Record<string, unknown> | null
) => {
  const eligible = isEligibleStudentVideo(nomination);
  const photoProvided = hasTeacherPhoto(nomination.photo_url);
  const videoUrl = video?.video_url ?? null;
  const generationStatus = eligible
    ? String(video?.generation_status || "pending")
    : "not_eligible";
  const reviewStatus = eligible ? String(video?.review_status || "none") : "not_eligible";

  return {
    nomination_id: nomination.id,
    teacher_name: nomination.teacher_name || null,
    teacher_phone: nomination.phone || null,
    teacher_photo_url: photoProvided ? nomination.photo_url : null,
    teacher_photo_provided: photoProvided,
    student_name: nomination.student_name || null,
    nominator_name: nomination.nominator_name || null,
    nominator_phone: nomination.nominator_phone || null,
    nomination_type: nomination.type,
    student_class: nomination.student_class || null,
    created_at: nomination.created_at || null,
    eligible,
    generation_status: generationStatus,
    review_status: reviewStatus,
    video_url: hasPlayableVideo(videoUrl) ? videoUrl : null,
    generated_at: video?.generated_at || null,
    approved_at: video?.approved_at || null,
    rejected_at: video?.rejected_at || null,
    rejection_reason: video?.rejection_reason || null,
    ready_for_message: Boolean(video?.ready_for_message),
    regenerate_available: false,
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
      type: "student",
      status: { $ne: "draft" },
    }).sort({ created_at: -1 });

    const jsons = nominations.map((n) => n.toJSON() as Record<string, unknown>);
    const ids = jsons.map((n) => String(n.id));
    const videos = await NominationVideo.find({ nomination_id: { $in: ids } });
    const videoByNomination = new Map(
      videos.map((v) => [v.nomination_id, v.toJSON() as Record<string, unknown>])
    );

    const items = jsons
      .filter((n) => isSubmittedStudentNomination(n))
      .map((n) => toReviewItem(n, videoByNomination.get(String(n.id)) || null));

    const counts = {
      total: items.length,
      with_photo: items.filter((i) => i.teacher_photo_provided).length,
      without_photo: items.filter((i) => !i.teacher_photo_provided).length,
      ready_for_review: items.filter((i) => filterKey(i) === "ready_for_review").length,
      approved: items.filter((i) => filterKey(i) === "approved").length,
      rejected: items.filter((i) => filterKey(i) === "rejected").length,
      failed: items.filter((i) => filterKey(i) === "failed").length,
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

    res.json(toReviewItem(nomination.toJSON() as Record<string, unknown>, video.toJSON() as Record<string, unknown>));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update video review";
    res.status(500).json({ error: message });
  }
});

export default router;
