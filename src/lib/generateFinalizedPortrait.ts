/**
 * Teacher-level finalized portrait: source photo → gpt-image-2 → top-60 crop → Cloudinary.
 * Video jobs must consume the cropped URL only — they must not call this.
 */
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import OpenAI, { toFile, APIError } from "openai";
import { v2 as cloudinary } from "cloudinary";
import { Nomination } from "../models/Nomination";
import { TeacherPortrait } from "../models/TeacherPortrait";
import { cropPortraitPng, CROP_VERSION } from "./applyApprovedPortraitCrop";
import {
  isFinalizedPortrait,
  teacherDisplayName,
  usableTeacherPhone,
} from "./nominationKind";
import { hasSourcePhoto } from "./sourcePhoto";
import { namesCompatible } from "./resolveTeacherPortrait";

export const PORTRAIT_PROMPT = [
  "IMAGE 1 is the identity source photograph of one specific real teacher. Recreate THIS exact person.",
  "Create a premium photorealistic professional studio portrait of the exact same individual.",
  "Preserve exactly: facial structure, face shape, forehead, jawline, cheeks, chin, nose, eyes, eyebrows, lips, ears, hairline, hairstyle, hair texture, skin tone, natural skin texture, facial asymmetry, moles/marks, age, expression, exact clothing, clothing colors, clothing pattern, jewelry, existing accessories.",
  "Do not create a lookalike. Do not redesign the face. Do not beautify. Do not make the person younger. Do not change skin tone, hairstyle, clothing, or jewelry. Do not add or remove accessories.",
  "The source may be a selfie, screenshot, or poorly framed photo. Do not paste a cutout selfie. Photograph the same person as a waist-up standing studio portrait with an 85mm full-frame look, large soft key light, subtle fill, realistic skin, hair, and fabric.",
  "Complete natural shoulders and upper torso consistent with the existing body and clothing. Do not invent a different outfit.",
  "Vertical 1088x1920 canvas. Teacher only on a fully transparent background. The silhouette must not touch the left, right, or bottom edges. Leave transparent margin. No white, gray, orange, black backdrop, room, wall, Instagram UI, halo, drop shadow, glow, text, or template graphics.",
].join(" ");

const MODEL = "gpt-image-2";
const MAX_RETRIES = 2;

export type SourceCandidate = {
  id: string;
  teacher_name: string;
  photo_url: string;
  created_at: string | null;
};

export type GeneratePortraitResult =
  | { ok: true; skipped: true; reason: "already_finalized" | "no_photo" | "generating"; phone: string }
  | { ok: true; skipped: false; phone: string; cropped_cloudinary_url: string; source_nomination_id: string }
  | { ok: false; needs_review: true; phone: string; reason: string; candidates: SourceCandidate[] }
  | { ok: false; needs_review: false; phone: string; error: string };

type NomRow = {
  _id: string;
  type?: string | null;
  student_class?: string | null;
  teacher_name?: string | null;
  full_name?: string | null;
  nominator_name?: string | null;
  photo_url?: string | null;
  created_at?: Date | string | null;
};

type PortraitRow = {
  teacher_phone?: string;
  teacher_name?: string | null;
  source_nomination_id?: string | null;
  source_photo_url?: string | null;
  portrait_status?: string | null;
  cropped_cloudinary_url?: string | null;
};

const text = (value: unknown) => String(value ?? "").trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const redact = (value: string) =>
  value.replace(/sk-[a-zA-Z0-9_\-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

const publicApiError = (err: unknown) => {
  if (err instanceof APIError) {
    return {
      openai_error: redact(err.message || ""),
      retryable: err.status === 429 || (err.status ?? 0) >= 500,
    };
  }
  const message = redact(err instanceof Error ? err.message : String(err));
  return {
    openai_error: message,
    retryable: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(message),
  };
};

const cloudinaryErrorMessage = (err: unknown) => {
  if (err instanceof Error && err.message) return redact(err.message);
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const http = rec.http_code || rec.statusCode || rec.status;
    const msg = rec.message || rec.error;
    return redact(`Cloudinary ${http || ""} ${typeof msg === "string" ? msg : JSON.stringify(msg || err)}`.trim());
  }
  return "Cloudinary upload failed";
};

const toCandidate = (n: NomRow): SourceCandidate => ({
  id: String(n._id),
  teacher_name: teacherDisplayName(n),
  photo_url: String(n.photo_url || ""),
  created_at: n.created_at ? new Date(n.created_at).toISOString() : null,
});

const groupName = (noms: NomRow[]) => {
  const names = noms.map((n) => teacherDisplayName(n)).filter(Boolean);
  return names[0] || "";
};

export const sourceCandidatesForPhone = (noms: NomRow[]): SourceCandidate[] => {
  const withPhoto = noms.filter((n) => hasSourcePhoto(n.photo_url));
  const seen = new Map<string, NomRow>();
  for (const n of withPhoto) {
    const url = String(n.photo_url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.set(url, n);
  }
  return [...seen.values()].map(toCandidate);
};

type SourceResolution =
  | { kind: "ok"; nomination: NomRow }
  | { kind: "no_photo" }
  | { kind: "invalid_source" }
  | { kind: "conflict"; candidates: SourceCandidate[] };

export const resolvePortraitSource = (
  noms: NomRow[],
  existing: PortraitRow | null | undefined,
  explicitSourceId?: string
): SourceResolution => {
  const withPhoto = noms.filter((n) => hasSourcePhoto(n.photo_url));
  if (!withPhoto.length) return { kind: "no_photo" };

  if (explicitSourceId) {
    const n = withPhoto.find((row) => String(row._id) === explicitSourceId);
    if (!n) return { kind: "invalid_source" };
    return { kind: "ok", nomination: n };
  }

  const storedId = text(existing?.source_nomination_id);
  const storedUrl = text(existing?.source_photo_url);
  if (storedId && storedUrl) {
    const n = withPhoto.find((row) => String(row._id) === storedId);
    if (n && String(n.photo_url || "").trim() === storedUrl) {
      return { kind: "ok", nomination: n };
    }
  }

  const representative = groupName(withPhoto);
  const nameConflict = withPhoto.some((n) => !namesCompatible(teacherDisplayName(n), representative));
  const uniqueUrls = new Map<string, NomRow>();
  for (const n of withPhoto) {
    if (representative && !namesCompatible(teacherDisplayName(n), representative)) continue;
    const url = String(n.photo_url || "").trim();
    if (url && !uniqueUrls.has(url)) uniqueUrls.set(url, n);
  }

  if (nameConflict || uniqueUrls.size > 1) {
    return { kind: "conflict", candidates: sourceCandidatesForPhone(withPhoto) };
  }
  if (uniqueUrls.size === 1) return { kind: "ok", nomination: [...uniqueUrls.values()][0] };
  return { kind: "no_photo" };
};

const downloadPhoto = async (photoUrl: string, destBase: string) => {
  const res = await fetch(photoUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Failed to download photo_url (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim();
  const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
  const dest = `${destBase}${ext}`;
  fs.writeFileSync(dest, buf);
  return {
    dest,
    contentType: contentType || "image/jpeg",
    hash: createHash("sha256").update(buf).digest("hex"),
  };
};

const uploadPng = async (filePath: string, publicId: string) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary is not configured");
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  let lastErr = "Cloudinary upload failed";
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const uploaded = await cloudinary.uploader.upload(filePath, {
        folder: "niat-awards/teacher-portraits",
        public_id: publicId,
        resource_type: "image",
        format: "png",
        overwrite: true,
        invalidate: true,
        unique_filename: false,
        use_filename: false,
      });
      if (!uploaded.secure_url) throw new Error("Cloudinary did not return a URL");
      return uploaded.secure_url as string;
    } catch (err) {
      lastErr = cloudinaryErrorMessage(err);
      if (attempt === 2) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error(lastErr);
};

const generateImage = async (client: OpenAI, sourcePath: string, contentType: string, destRaw: string) => {
  const identity = await toFile(fs.createReadStream(sourcePath), path.basename(sourcePath), {
    type: contentType,
  });
  let lastErr: ReturnType<typeof publicApiError> | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.images.edit({
        model: MODEL,
        image: identity,
        prompt: PORTRAIT_PROMPT,
        background: "transparent",
        quality: "high",
        n: 1,
        size: "1088x1920" as "1024x1536",
      });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) throw new Error("images.edit returned no b64_json");
      fs.writeFileSync(destRaw, Buffer.from(b64, "base64"));
      return;
    } catch (err) {
      lastErr = publicApiError(err);
      if (!lastErr.retryable || attempt === MAX_RETRIES) {
        throw new Error(lastErr.openai_error || "image generation failed");
      }
      await sleep(15000 * (attempt + 1));
    }
  }
  throw new Error(lastErr?.openai_error || "image generation failed");
};

const markFailed = async (phone: string, name: string, error: string) => {
  await TeacherPortrait.findOneAndUpdate(
    { teacher_phone: phone },
    {
      $set: {
        teacher_name: name || null,
        portrait_status: "FAILED",
        portrait_error: error.slice(0, 1000),
      },
      $setOnInsert: { teacher_phone: phone },
    },
    { upsert: true }
  );
};

const markNeedsReview = async (phone: string, name: string, reason: string) => {
  await TeacherPortrait.findOneAndUpdate(
    { teacher_phone: phone },
    {
      $set: {
        teacher_name: name || null,
        portrait_status: "NEEDS_REVIEW",
        portrait_error: reason.slice(0, 1000),
      },
      $setOnInsert: { teacher_phone: phone },
    },
    { upsert: true }
  );
};

export const generateFinalizedPortrait = async (opts: {
  phone: string;
  regenerate?: boolean;
  source_nomination_id?: string;
}): Promise<GeneratePortraitResult> => {
  const phone = usableTeacherPhone(opts.phone);
  if (!phone) {
    return { ok: false, needs_review: false, phone: String(opts.phone || ""), error: "Invalid teacher phone" };
  }

  const noms = (await Nomination.find({
    status: { $ne: "draft" },
    phone: { $regex: phone },
  })
    .select("_id type student_class teacher_name full_name nominator_name photo_url phone created_at")
    .lean()) as Array<NomRow & { phone?: unknown }>;
  const forPhone = noms.filter((n) => usableTeacherPhone(n.phone) === phone);
  const name = groupName(forPhone);
  const existing = (await TeacherPortrait.findOne({ teacher_phone: phone }).lean()) as PortraitRow | null;

  if (String(existing?.portrait_status || "") === "PROCESSING") {
    return { ok: true, skipped: true, reason: "generating", phone };
  }

  if (isFinalizedPortrait(existing) && !opts.regenerate) {
    return { ok: true, skipped: true, reason: "already_finalized", phone };
  }

  const source = resolvePortraitSource(forPhone, existing, text(opts.source_nomination_id) || undefined);
  if (source.kind === "no_photo") {
    await TeacherPortrait.findOneAndUpdate(
      { teacher_phone: phone },
      {
        $set: {
          teacher_name: name || null,
          portrait_status: "NOT_PROVIDED",
          portrait_error: null,
        },
        $setOnInsert: { teacher_phone: phone },
      },
      { upsert: true }
    );
    return { ok: true, skipped: true, reason: "no_photo", phone };
  }
  if (source.kind === "invalid_source") {
    return { ok: false, needs_review: false, phone, error: "source_nomination_id is not a photo nomination for this teacher" };
  }
  if (source.kind === "conflict") {
    await markNeedsReview(phone, name, "conflicting source photos or names");
    return { ok: false, needs_review: true, phone, reason: "conflicting source photos or names", candidates: source.candidates };
  }

  const claimed = await TeacherPortrait.findOneAndUpdate(
    { teacher_phone: phone },
    {
      $set: {
        teacher_name: name || teacherDisplayName(source.nomination) || null,
        portrait_status: "PROCESSING",
        portrait_error: null,
      },
      $setOnInsert: { teacher_phone: phone },
    },
    { upsert: true, new: true }
  );
  if (!claimed) {
    return { ok: true, skipped: true, reason: "generating", phone };
  }

  const apiKey = String(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  const baseURL = String(
    process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.openai.com/v1"
  ).trim();
  if (!apiKey) {
    await markFailed(phone, name, "Missing OPENAI_API_KEY");
    return { ok: false, needs_review: false, phone, error: "Missing OPENAI_API_KEY" };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `portrait-${phone}-`));
  try {
    const photoUrl = String(source.nomination.photo_url || "");
    const downloaded = await downloadPhoto(photoUrl, path.join(workDir, "source"));
    const rawPng = path.join(workDir, "gpt-raw.png");
    const croppedPng = path.join(workDir, "cropped.png");
    const client = new OpenAI({ apiKey, baseURL });
    await generateImage(client, downloaded.dest, downloaded.contentType, rawPng);
    const cropped = cropPortraitPng(fs.readFileSync(rawPng));
    if (cropped.geometry.size[0] !== 1080 || cropped.geometry.size[1] !== 1920) {
      throw new Error("cropped canvas is not 1080x1920");
    }
    if (cropped.geometry.visible_bottom !== 1372) {
      throw new Error(`visible bottom ${cropped.geometry.visible_bottom} != 1372`);
    }
    fs.writeFileSync(croppedPng, cropped.png);

    const rawUrl = await uploadPng(rawPng, `${phone}-gpt-raw`);
    const croppedUrl = await uploadPng(croppedPng, phone);
    const now = new Date();

    await TeacherPortrait.findOneAndUpdate(
      { teacher_phone: phone },
      {
        $set: {
          teacher_name: name || teacherDisplayName(source.nomination) || null,
          source_nomination_id: String(source.nomination._id),
          source_photo_url: photoUrl,
          source_photo_hash: downloaded.hash,
          portrait_cloudinary_url: rawUrl,
          cropped_cloudinary_url: croppedUrl,
          portrait_status: "GENERATED",
          portrait_error: null,
          crop_version: CROP_VERSION,
          generated_at: now,
          finalized_at: now,
        },
      }
    );

    return {
      ok: true,
      skipped: false,
      phone,
      cropped_cloudinary_url: croppedUrl,
      source_nomination_id: String(source.nomination._id),
    };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    await markFailed(phone, name, message);
    return { ok: false, needs_review: false, phone, error: message };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
