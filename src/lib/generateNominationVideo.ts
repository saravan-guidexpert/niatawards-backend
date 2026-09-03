import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import { Nomination } from "../models/Nomination";
import {
  NominationVideo,
  PRODUCTION_AUDIO_FILENAME,
  PRODUCTION_VIDEO_BATCH_ID,
} from "../models/NominationVideo";
import { TeacherPortrait } from "../models/TeacherPortrait";
import type { VideoFailureStage } from "../models/VideoGenerationJob";
import { rasterizeCategoryIcon, resolveCategoryIcon } from "./categoryIcons";
import {
  STUDENT_VIDEO_TEMPLATE,
  isFinalizedPortrait,
  nominationKind,
  teacherDisplayName,
  templatePlacesCategoryIcon,
  usableTeacherPhone,
  videoTemplateOf,
  type VideoTemplateVariant,
} from "./nominationKind";
import { videoSatisfiesNomination } from "./videoIdentity";
import {
  bgRemoveRoot,
  encodeTeacherVideo,
  materializeCroppedPortrait,
  newVideoRenderId,
  publishTeacherVideo,
  pythonBin,
  renderPaths,
} from "./renderTeacherVideo";
import { hasSourcePhoto } from "./sourcePhoto";
import {
  readPreviewIconMeta,
  writePreviewIconMeta,
} from "./teacherPortrait";

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const PHOTO_AREA_BOTTOM = 1372;

export class VideoPipelineError extends Error {
  stage: VideoFailureStage;
  constructor(stage: VideoFailureStage, message: string) {
    super(message);
    this.name = "VideoPipelineError";
    this.stage = stage;
  }
}

export const hasPlayableVideoUrl = (url: unknown) => /^https?:\/\//i.test(String(url || "").trim());

export const isSuccessfulFinalVideo = (video: {
  generation_status?: unknown;
  video_url?: unknown;
} | null | undefined) =>
  String(video?.generation_status || "") === "generated" && hasPlayableVideoUrl(video?.video_url);

const audioOk = (payload: Record<string, unknown>) => {
  const validation = (payload.validation || {}) as Record<string, unknown>;
  const generated = (validation.generated || {}) as Record<string, unknown>;
  return Boolean(payload.ok) && Boolean(generated.has_audio || validation.ok);
};

const assertPreparedCanvas = (filePath: string) => {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  if (png.width !== CANVAS_W || png.height !== CANVAS_H) {
    throw new VideoPipelineError(
      "PORTRAIT_RESOLUTION",
      `finalized portrait is ${png.width}x${png.height}, expected ${CANVAS_W}x${CANVAS_H}`
    );
  }
  return png;
};

export const generateNominationVideo = async (opts: {
  nominationId: string;
  jobId?: string | null;
  regenerate?: boolean;
}): Promise<{
  nomination_id: string;
  render_id: string;
  video_url: string;
  photo_used: boolean;
  video_category: "with_photo" | "without_photo";
  category_icon_id: string;
  category_icon_filename: string;
}> => {
  const nominationId = String(opts.nominationId || "").trim();
  const nom = await Nomination.findById(nominationId)
    .select(
      "_id type status student_class phone teacher_name full_name nominator_name student_name photo_url"
    )
    .lean();
  if (!nom) throw new VideoPipelineError("DATABASE", "nomination not found");
  if (String(nom.status || "") === "draft") {
    throw new VideoPipelineError("DATABASE", "draft nominations are not eligible");
  }

  const existing = await NominationVideo.findOne({ nomination_id: nominationId }).lean();
  const expectedKind = nominationKind(nom);
  const variant = videoTemplateOf(expectedKind);
  if (
    videoSatisfiesNomination({
      video: existing,
      nominationId,
      expectedKind,
    }) &&
    !opts.regenerate
  ) {
    return {
      nomination_id: nominationId,
      render_id: String(existing?.video_render_id || ""),
      video_url: String(existing?.video_url || ""),
      photo_used: Boolean(existing?.photo_used),
      video_category: existing?.video_category === "with_photo" ? "with_photo" : "without_photo",
      category_icon_id: String(existing?.category_icon_id || ""),
      category_icon_filename: String(existing?.category_icon_filename || ""),
    };
  }

  const phone = usableTeacherPhone(nom.phone);
  const teacherName = teacherDisplayName(nom);
  if (!teacherName) throw new VideoPipelineError("VIDEO_RENDER", "missing teacher name");
  const nominatorName = String(nom.student_name || nom.nominator_name || "").trim();
  const wantsPhoto = hasSourcePhoto(nom.photo_url);
  const videoCategory: "with_photo" | "without_photo" = wantsPhoto ? "with_photo" : "without_photo";

  let croppedUrl = "";
  let croppedLocal = "";
  if (wantsPhoto) {
    if (!phone) {
      throw new VideoPipelineError("PORTRAIT_RESOLUTION", "teacher phone is missing or invalid");
    }
    const portrait = await TeacherPortrait.findOne({ teacher_phone: phone }).lean();
    if (!isFinalizedPortrait(portrait)) {
      throw new VideoPipelineError(
        "PORTRAIT_RESOLUTION",
        "teacher does not have a valid finalized TeacherPortrait"
      );
    }
    const portraitPhone = usableTeacherPhone(portrait?.teacher_phone);
    if (portraitPhone !== phone) {
      throw new VideoPipelineError("PORTRAIT_RESOLUTION", "portrait phone does not match this teacher");
    }
    croppedUrl = String(portrait?.cropped_cloudinary_url || "").trim();
    croppedLocal = String(portrait?.cropped_local_png_path || "").trim();
    if (!croppedUrl && !croppedLocal) {
      throw new VideoPipelineError("PORTRAIT_RESOLUTION", "finalized portrait Cloudinary URL is missing");
    }
  }

  const root = bgRemoveRoot();
  const renderId = newVideoRenderId();
  const paths = renderPaths(root, nominationId, renderId);
  fs.mkdirSync(paths.renderDir, { recursive: true });

  const previewMeta = readPreviewIconMeta(nominationId);
  const icon = resolveCategoryIcon(
    root,
    existing?.category_icon_filename || previewMeta?.category_icon_filename || null
  );
  const iconPng = path.join(paths.renderDir, "category-icon.png");
  rasterizeCategoryIcon(icon.svgPath, iconPng);
  writePreviewIconMeta(nominationId, {
    category_icon_id: icon.category_icon_id,
    category_icon_filename: icon.category_icon_filename,
  });
  // Teacher-nomination Frame 2 has no icon slot; still pick and store an icon in metadata.
  const placeIcon = templatePlacesCategoryIcon(variant);

  let preparedPath = "";
  if (wantsPhoto) {
    try {
      preparedPath = await materializeCroppedPortrait({
        dest: paths.preparedPath,
        localPath: croppedLocal,
        cloudinaryUrl: croppedUrl,
      });
      assertPreparedCanvas(preparedPath);
    } catch (err) {
      if (err instanceof VideoPipelineError) throw err;
      throw new VideoPipelineError(
        "PORTRAIT_RESOLUTION",
        err instanceof Error ? err.message : "failed to load finalized portrait"
      );
    }
  }

  let encoded;
  try {
    encoded = await encodeTeacherVideo({
      nominationId,
      teacherName,
      nominatorName,
      renderId,
      preparedPortraitPath: preparedPath || null,
      categoryIconPath: placeIcon ? iconPng : null,
      categoryIconId: icon.category_icon_id,
      categoryIconFilename: icon.category_icon_filename,
      variant,
    });
  } catch (err) {
    throw new VideoPipelineError(
      "VIDEO_RENDER",
      err instanceof Error ? err.message : "video render failed"
    );
  }

  if (!audioOk(encoded.payload)) {
    throw new VideoPipelineError("AUDIO", "rendered MP4 is missing a valid audio stream");
  }

  const photoUsed = Boolean(encoded.payload.photo_used);
  if (wantsPhoto) {
    if (!photoUsed) {
      throw new VideoPipelineError("VIDEO_RENDER", "with-photo render did not use the finalized portrait");
    }
    const placement = (encoded.payload.placement || null) as Record<string, unknown> | null;
    const sh = Number(placement?.sprite_height);
    const py = Number(placement?.paste_y);
    if (Number.isFinite(sh) && Number.isFinite(py) && py + sh !== PHOTO_AREA_BOTTOM) {
      throw new VideoPipelineError(
        "VIDEO_RENDER",
        `placement assert failed paste_y+height=${py}+${sh}`
      );
    }
  } else if (photoUsed) {
    throw new VideoPipelineError("VIDEO_RENDER", "no-photo render inserted a portrait");
  }

  let published;
  try {
    published = await publishTeacherVideo(encoded, nominationId);
  } catch (err) {
    throw new VideoPipelineError(
      "CLOUDINARY_UPLOAD",
      err instanceof Error ? err.message : "Cloudinary upload failed"
    );
  }

  try {
    await NominationVideo.findOneAndUpdate(
      { nomination_id: nominationId },
      {
        $set: {
          nomination_id: nominationId,
          generation_status: "generated",
          review_status: "ready_for_review",
          video_url: published.videoUrl,
          video_render_id: renderId,
          generated_at: new Date(),
          ready_for_message: false,
          generation_error: null,
          portrait_cloudinary_url: wantsPhoto ? croppedUrl : null,
          photo_used: photoUsed,
          video_category: videoCategory,
          category_icon_id: icon.category_icon_id,
          category_icon_filename: icon.category_icon_filename,
          audio_filename: PRODUCTION_AUDIO_FILENAME,
          production_batch_id: PRODUCTION_VIDEO_BATCH_ID,
          generation_job_id: opts.jobId ? String(opts.jobId) : null,
          nomination_kind: expectedKind,
          video_template: variant,
        },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    throw new VideoPipelineError(
      "DATABASE",
      err instanceof Error ? err.message : "failed to save NominationVideo"
    );
  }

  return {
    nomination_id: nominationId,
    render_id: renderId,
    video_url: published.videoUrl,
    photo_used: photoUsed,
    video_category: videoCategory,
    category_icon_id: icon.category_icon_id,
    category_icon_filename: icon.category_icon_filename,
  };
};

export const markNominationVideoFailed = async (
  nominationId: string,
  error: string,
  jobId?: string | null
) => {
  const existing = await NominationVideo.findOne({ nomination_id: nominationId })
    .lean()
    .catch(() => null);
  // A failed regenerate must not throw away the video that is already live.
  const keepExisting = isSuccessfulFinalVideo(existing);
  await NominationVideo.findOneAndUpdate(
    { nomination_id: nominationId },
    {
      $set: {
        nomination_id: nominationId,
        ...(keepExisting ? {} : { generation_status: "failed", ready_for_message: false }),
        generation_error: error.slice(0, 2000),
        generation_job_id: jobId ? String(jobId) : null,
      },
    },
    { upsert: true }
  ).catch(() => undefined);
};

export const composeNominationPreview = async (opts: {
  nominationId: string;
  teacherName: string;
  preparedPortraitPath?: string | null;
  categoryIconPath: string;
  outputPath: string;
  variant?: VideoTemplateVariant;
}) => {
  const root = bgRemoveRoot();
  const jobPath = `${opts.outputPath}.job.json`;
  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  const variant = opts.variant || STUDENT_VIDEO_TEMPLATE;
  fs.writeFileSync(
    jobPath,
    JSON.stringify(
      {
        teacher_name: opts.teacherName,
        prepared_portrait_path: String(opts.preparedPortraitPath || ""),
        category_icon_path: templatePlacesCategoryIcon(variant) ? opts.categoryIconPath : "",
        variant,
        output: opts.outputPath,
      },
      null,
      2
    )
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pythonBin(root), [path.join(root, "compose_preview.py"), jobPath], {
      cwd: root,
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0 && fs.existsSync(opts.outputPath)) resolve();
      else reject(new Error(stderr.trim() || `preview compose failed (${status})`));
    });
  });
  return opts.outputPath;
};
