import path from "path";
import fs from "fs";
import { Router, Request, Response } from "express";

export const nominationVideoDir = () =>
  path.resolve(__dirname, "../../storage/nomination-videos");

const router = Router();

router.get("/:id.mp4", (req: Request, res: Response) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ error: "Invalid nomination id" });
    return;
  }
  const file = path.join(nominationVideoDir(), `${id}.mp4`);
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "private, max-age=120");
  res.sendFile(file);
});

export default router;
