import { Router, Request, Response } from "express";
import { Vote } from "../models/Vote";
import { Nomination } from "../models/Nomination";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const voterPhone = req.query.voter_phone ? String(req.query.voter_phone) : null;
    const filter = voterPhone ? { voter_phone: voterPhone } : {};
    const votes = await Vote.find(filter).select("nomination_id created_at voter_phone");
    res.json(votes.map((v) => v.toJSON()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load votes";
    res.status(500).json({ error: message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const { nomination_id, voter_phone } = req.body ?? {};
    if (!nomination_id || !voter_phone) {
      res.status(400).json({ error: "nomination_id and voter_phone are required" });
      return;
    }

    const nomination = await Nomination.findById(nomination_id);
    if (!nomination) {
      res.status(404).json({ error: "Nomination not found" });
      return;
    }
    if (!["shortlisted", "winner"].includes(nomination.status)) {
      res.status(400).json({ error: "This nomination is not open for voting" });
      return;
    }

    const alreadyVoted = await Vote.exists({ voter_phone: String(voter_phone) });
    if (alreadyVoted) {
      res.status(409).json({ error: "You have already voted.", code: "23505" });
      return;
    }

    const vote = await Vote.create({
      nomination_id,
      voter_phone: String(voter_phone),
    });
    res.status(201).json(vote.toJSON());
  } catch (err: unknown) {
    const mongoErr = err as { code?: number; message?: string };
    if (mongoErr.code === 11000) {
      res.status(409).json({ error: "You have already voted.", code: "23505" });
      return;
    }
    const message = err instanceof Error ? err.message : "Failed to cast vote";
    res.status(500).json({ error: message });
  }
});

export default router;
