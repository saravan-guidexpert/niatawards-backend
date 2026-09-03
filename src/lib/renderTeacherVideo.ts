import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { v2 as cloudinary } from "cloudinary";
import { listCategoryIcons } from "./categoryIcons";
import { bgRemoveRoot, nominationVideoDir } from "./projectPaths";
import { portraitPreviewPath, teacherPortraitDir } from "./teacherPortrait";

export { bgRemoveRoot } from "./projectPaths";

export const PRODUCTION_AUDIO_FILENAME = "nominated-by-students.mp3";

export const soundtrackPath = (root = bgRemoveRoot()) =>
  path.join(root, "assets", "teacher-student", "audio", PRODUCTION_AUDIO_FILENAME);

export const newVideoRenderId = () => `${Date.now()}-${randomBytes(6).toString("hex")}`;

export const pythonBin = (root: string) => {
  const venv = path.join(root, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
};

export const publicApiBase = () =>
  (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, "");

/**
 * Fails fast when the renderer cannot possibly succeed, so a bad environment
 * rejects one request instead of burning through a whole queue.
 */
export const assertVideoRenderReady = () => {
  const root = bgRemoveRoot();
  const script = path.join(root, "generate_one_nomination.py");
  if (!fs.existsSync(script)) throw new Error(`renderer script missing: ${script}`);
  const audio = soundtrackPath(root);
  if (!fs.existsSync(audio)) throw new Error(`soundtrack missing: ${audio}`);
  listCategoryIcons(root);
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error("Cloudinary is not configured");
  }
  const probe = spawnSync(pythonBin(root), ["-c", "import PIL, numpy, imageio_ffmpeg"], {
    cwd: root,
    timeout: 20_000,
  });
  if (probe.status !== 0) {
    const detail = String(probe.stderr || probe.error?.message || "").trim().slice(-400);
    throw new Error(`renderer Python dependencies unavailable: ${detail || "unknown error"}`);
  }
  return root;
};

export const renderPaths = (root: string, nominationId: string, renderId: string) => {
  const renderDir = path.join(root, "work", "renders", nominationId, renderId);
  const workDir = path.join(renderDir, "work");
  return {
    renderDir,
    workDir,
    preparedPath: path.join(renderDir, "prepared.png"),
    jobPath: path.join(renderDir, "job.json"),
    resultPath: path.join(workDir, "result.json"),
    pipelineOut: path.join(root, "output", "videos", "renders", nominationId, `${renderId}.mp4`),
    serveOut: path.join(nominationVideoDir(), nominationId, `${renderId}.mp4`),
  };
};

export const materializeCroppedPortrait = async (opts: {
  dest: string;
  localPath?: string | null;
  cloudinaryUrl?: string | null;
}) => {
  fs.mkdirSync(path.dirname(opts.dest), { recursive: true });
  const local = String(opts.localPath || "").trim();
  if (local && fs.existsSync(local)) {
    fs.copyFileSync(local, opts.dest);
    return opts.dest;
  }
  const url = String(opts.cloudinaryUrl || "").trim();
  if (!url) throw new Error("cropped portrait missing locally and no Cloudinary URL");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download cropped portrait HTTP ${res.status}`);
  fs.writeFileSync(opts.dest, Buffer.from(await res.arrayBuffer()));
  return opts.dest;
};

const configureCloudinary = () => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary is not configured");
  }
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
};

let uploadChain: Promise<void> = Promise.resolve();

const withUploadLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void = () => undefined;
  const previous = uploadChain;
  uploadChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
};

const failMessage = (value: unknown, fallback: string) => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value instanceof Error && value.message) return value.message;
  if (value && typeof value === "object") {
    const record = value as { message?: unknown; error?: { message?: unknown } };
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.error?.message === "string" && record.error.message.trim()) {
      return record.error.message.trim();
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}" && json !== "null") return json;
    } catch {
      /* ignore */
    }
  }
  return fallback;
};

export const uploadTeacherVideo = async (filePath: string, nominationId: string, renderId: string) =>
  withUploadLock(async () => {
    configureCloudinary();
    try {
      const uploaded = await cloudinary.uploader.upload(filePath, {
        resource_type: "video",
        public_id: `niat-awards/teacher-videos/${nominationId}/${renderId}`,
        overwrite: true,
        unique_filename: false,
        use_filename: false,
        timeout: 180_000,
      });
      if (!uploaded.secure_url) throw new Error("Cloudinary did not return a video URL");
      return String(uploaded.secure_url);
    } catch (err) {
      throw new Error(failMessage(err, "Cloudinary upload failed").slice(0, 2000));
    }
  });

export type RenderTeacherVideoInput = {
  nominationId: string;
  teacherName: string;
  nominatorName: string;
  renderId: string;
  preparedPortraitPath?: string | null;
  categoryIconPath?: string | null;
  categoryIconId?: string | null;
  categoryIconFilename?: string | null;
};

export type RenderTeacherVideoResult = {
  renderId: string;
  outputPath: string;
  serveOut: string;
  videoUrl: string;
  payload: Record<string, unknown>;
};

const runPythonEncode = (root: string, jobPath: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(pythonBin(root), [path.join(root, "generate_one_nomination.py"), jobPath], {
      cwd: root,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const cap = (current: string, chunk: Buffer | string) => (current + String(chunk)).slice(-2_000_000);
    child.stdout.on("data", (chunk) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = cap(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

/** Encodes one nomination video. Consumes a prepared (finalized cropped) portrait path; never calls OpenAI. */
export const encodeTeacherVideo = async (
  input: RenderTeacherVideoInput
): Promise<Omit<RenderTeacherVideoResult, "videoUrl">> => {
  const root = bgRemoveRoot();
  const paths = renderPaths(root, input.nominationId, input.renderId);
  if (fs.existsSync(paths.workDir)) fs.rmSync(paths.workDir, { recursive: true, force: true });
  fs.mkdirSync(paths.workDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.pipelineOut), { recursive: true });
  fs.mkdirSync(path.dirname(paths.serveOut), { recursive: true });

  const prepared = String(input.preparedPortraitPath || "").trim();
  const audio = soundtrackPath(root);
  if (!fs.existsSync(audio)) throw new Error(`soundtrack missing: ${audio}`);
  const job: Record<string, string> = {
    nomination_id: input.nominationId,
    teacher_name: input.teacherName,
    nominator_name: input.nominatorName,
    render_id: input.renderId,
    work_dir: paths.workDir,
    output: paths.pipelineOut,
    result: paths.resultPath,
    prepared_portrait_path: prepared,
    category_icon_path: String(input.categoryIconPath || "").trim(),
    category_icon_id: String(input.categoryIconId || "").trim(),
    category_icon_filename: String(input.categoryIconFilename || "").trim(),
    audio_path: soundtrackPath(root),
    photo_url: "",
  };
  fs.writeFileSync(paths.jobPath, JSON.stringify(job, null, 2));

  const py = await runPythonEncode(root, paths.jobPath);
  let payload: Record<string, unknown> = {};
  if (fs.existsSync(paths.resultPath)) {
    try {
      payload = JSON.parse(fs.readFileSync(paths.resultPath, "utf8")) as Record<string, unknown>;
    } catch {
      payload = { error: py.stderr || py.stdout };
    }
  } else {
    payload = { error: py.stderr || py.stdout || "missing result.json" };
  }
  if (py.status !== 0 || payload.ok === false) {
    throw new Error(failMessage(payload.error || py.stderr || py.stdout, "render failed").slice(0, 2000));
  }
  if (!fs.existsSync(paths.pipelineOut)) throw new Error("renderer did not write mp4");
  fs.copyFileSync(paths.pipelineOut, paths.serveOut);
  const overlay = path.join(paths.workDir, "overlay_section2.png");
  if (fs.existsSync(overlay)) {
    fs.mkdirSync(teacherPortraitDir(), { recursive: true });
    fs.copyFileSync(overlay, portraitPreviewPath(input.nominationId));
  }
  return {
    renderId: input.renderId,
    outputPath: paths.pipelineOut,
    serveOut: paths.serveOut,
    payload,
  };
};

export const publishTeacherVideo = async (
  encoded: Omit<RenderTeacherVideoResult, "videoUrl">,
  nominationId: string
): Promise<RenderTeacherVideoResult> => {
  const videoUrl = await uploadTeacherVideo(encoded.outputPath, nominationId, encoded.renderId);
  return { ...encoded, videoUrl };
};
