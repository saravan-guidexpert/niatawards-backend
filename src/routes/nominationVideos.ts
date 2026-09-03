import path from "path";
import fs from "fs";
import { Router, Request, Response } from "express";
import { portraitPngPath, portraitPreviewPath } from "../lib/teacherPortrait";

export const nominationVideoDir = () =>
  path.resolve(__dirname, "../../storage/nomination-videos");

const router = Router();

const nominationId = (value: unknown) => {
  const id = String(value || "").trim();
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};

const sendPng = (res: Response, file: string) => {
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: "Portrait not found" });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=120");
  res.sendFile(file);
};

const sendVideo = (res: Response, file: string) => {
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(file);
};

const renderId = (value: unknown) => {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{6,80}$/.test(id) ? id : null;
};

router.get("/:id/:renderId.mp4", (req: Request, res: Response) => {
  const id = nominationId(req.params.id);
  const rid = renderId(req.params.renderId);
  if (!id || !rid) {
    res.status(400).json({ error: "Invalid nomination or render id" });
    return;
  }
  sendVideo(res, path.join(nominationVideoDir(), id, `${rid}.mp4`));
});

router.get("/:id.mp4", (req: Request, res: Response) => {
  const id = nominationId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid nomination id" });
    return;
  }
  sendVideo(res, path.join(nominationVideoDir(), `${id}.mp4`));
});

router.get("/:id/portrait", (req: Request, res: Response) => {
  const id = nominationId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid nomination id" });
    return;
  }
  sendPng(res, portraitPngPath(id));
});

router.get("/:id/portrait-preview", (req: Request, res: Response) => {
  const id = nominationId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid nomination id" });
    return;
  }
  sendPng(res, portraitPreviewPath(id));
});

export default router;
