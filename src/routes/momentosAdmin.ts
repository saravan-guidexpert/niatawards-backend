import { Request, Response, Router } from "express";
import { MOMENTO_TEACHERS } from "../data/momentoTeachers";
import { buildMomentoRows } from "../lib/momentos";
import { phone10 } from "../lib/resolveTeacherPortrait";
import { Nomination } from "../models/Nomination";
import { NominationVideo } from "../models/NominationVideo";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  try {
    const roster = MOMENTO_TEACHERS;
    const rosterPhones = new Set(roster.map((row) => row.phone).filter((phone) => phone.length === 10));

    const nominations = await Nomination.find({ status: { $ne: "draft" } })
      .select("_id phone status")
      .lean();

    const relevant = nominations.filter((nomination) => rosterPhones.has(phone10(nomination.phone)));
    const nominationIds = relevant.map((nomination) => String(nomination._id));

    const videos = nominationIds.length
      ? await NominationVideo.find({ nomination_id: { $in: nominationIds } })
          .select("nomination_id category_icon_filename video_url generated_at generation_status")
          .lean()
      : [];

    const items = buildMomentoRows(roster, relevant, videos);

    res.json({
      items,
      total: items.length,
      matched: items.filter((item) => item.matched).length,
      with_momento: items.filter((item) => item.momentos.length > 0).length,
      not_generated: items.filter((item) => item.video_count === 0).length,
    });
  } catch (error) {
    console.error("[momentos]", error);
    res.status(500).json({ error: "Failed to load momentos" });
  }
});

export default router;
