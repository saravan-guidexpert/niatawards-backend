import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const router = Router();

const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
};

const isAllowedFile = (file: Express.Multer.File) => {
  const ext = extOf(file.originalname || "");
  if (ALLOWED_EXT.has(ext)) return true;
  return ALLOWED_MIME.has((file.mimetype || "").toLowerCase());
};

const receivePhoto = (req: Request, res: Response, next: NextFunction) => {
  upload.single("photo")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "Photo must be 3MB or smaller" });
      return;
    }
    if (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      res.status(400).json({ error: message });
      return;
    }
    next();
  });
};

router.post("/photo", receivePhoto, async (req: Request, res: Response) => {
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      res.status(500).json({ error: "Photo uploads are not configured" });
      return;
    }

    const file = req.file;
    if (!file?.buffer) {
      res.status(400).json({ error: "Choose a teacher photo to upload" });
      return;
    }
    if (file.size > MAX_BYTES) {
      res.status(400).json({ error: "Photo must be 3MB or smaller" });
      return;
    }
    if (!isAllowedFile(file)) {
      res.status(400).json({ error: "Use a JPG, PNG, WebP, or HEIC photo" });
      return;
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
    });

    const ext = extOf(file.originalname || "");
    const forceJpg = ext === ".heic" || ext === ".heif" || file.mimetype.includes("heic") || file.mimetype.includes("heif");

    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "niat-awards/teachers",
          resource_type: "image",
          format: forceJpg ? "jpg" : undefined,
          transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto", fetch_format: "auto" }],
        },
        (error, uploaded) => {
          if (error || !uploaded?.secure_url) {
            reject(error || new Error("Cloudinary did not return a URL"));
            return;
          }
          resolve({ secure_url: uploaded.secure_url });
        }
      );
      stream.end(file.buffer);
    });

    res.json({ photo_url: result.secure_url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to upload photo";
    res.status(500).json({ error: message });
  }
});

export default router;
