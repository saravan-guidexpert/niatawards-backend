import fs from "fs";
import path from "path";

export const PORTRAIT_STATUSES = [
  "NOT_STARTED",
  "PROCESSING",
  "READY",
  "NEEDS_REVIEW",
  "FAILED",
  "NOT_PROVIDED",
] as const;

export type PortraitStatus = (typeof PORTRAIT_STATUSES)[number];

export const teacherPortraitDir = () =>
  path.resolve(__dirname, "../../../bg-remove/output/teacher-portraits");

export const portraitPngPath = (nominationId: string) =>
  path.join(teacherPortraitDir(), `${nominationId}.png`);

export const portraitPreviewPath = (nominationId: string) =>
  path.join(teacherPortraitDir(), `${nominationId}-preview.png`);

export const portraitReportPath = (nominationId: string) =>
  path.join(teacherPortraitDir(), `${nominationId}-report.json`);

const readJson = (file: string): Record<string, unknown> | null => {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const nested = (obj: Record<string, unknown> | null, key: string) => {
  const value = obj?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const flag = (...values: unknown[]) => values.find((value) => typeof value === "boolean") as boolean | undefined;

export type PortraitReportSummary = {
  validation_status: string | null;
  background_removed: boolean | null;
  alpha_valid: boolean | null;
  halo_detected: boolean | null;
  composition_valid: boolean | null;
  source_appearance_preserved: boolean | null;
};

export const summarizePortraitReport = (
  report: Record<string, unknown> | null
): PortraitReportSummary | null => {
  if (!report) return null;
  const checks = nested(report, "checks") || nested(nested(report, "inspection"), "checks") || {};
  const halo = nested(report, "halo_analysis") || nested(nested(report, "alpha_analysis"), "flags") || {};
  const identity = nested(report, "identity_preservation") || {};
  const method = String(report.method || nested(report, "build")?.method || "");
  const provenOriginal = method.startsWith("original_pixels+rembg_mask");

  return {
    validation_status: report.validation_status ? String(report.validation_status) : null,
    background_removed: flag(checks.background_has_true_transparency) ?? null,
    alpha_valid: flag(checks.teacher_body_fully_opaque, nested(report, "alpha_analysis")?.teacher_body_fully_opaque) ?? null,
    halo_detected: flag(halo.dark_halo_detected, checks.dark_halo_detected) ?? null,
    composition_valid: flag(checks.composition_matches_02, checks.fits_02_photo_area) ?? null,
    source_appearance_preserved: provenOriginal
      ? identity.face_appearance_changed_significantly === false &&
        identity.clothing_changed !== true &&
        identity.new_jewelry_or_accessories_detected !== true
      : null,
  };
};

export const portraitStatusFor = (opts: {
  photoProvided: boolean;
  nominationId: string;
}): PortraitStatus => {
  if (!opts.photoProvided) return "NOT_PROVIDED";
  const png = portraitPngPath(opts.nominationId);
  const tmp = `${png}.tmp`;
  const report = readJson(portraitReportPath(opts.nominationId));
  const pngExists = fs.existsSync(png);
  const tmpExists = fs.existsSync(tmp);

  if (tmpExists && !pngExists) return "PROCESSING";

  if (report) {
    const status = String(report.validation_status || "").toLowerCase();
    if (report.generation_success === false || status === "fail") return "FAILED";
    if (status === "needs_review" || status === "needs_manual_review") return "NEEDS_REVIEW";
    if (pngExists && report.generation_success === true && (status === "pass" || status === "success")) {
      return "READY";
    }
  }

  return "NOT_STARTED";
};

export const portraitPublicPaths = (nominationId: string) => {
  const pngExists = fs.existsSync(portraitPngPath(nominationId));
  const previewExists = fs.existsSync(portraitPreviewPath(nominationId));
  return {
    portrait_url: pngExists ? `/api/nomination-videos/${nominationId}/portrait` : null,
    portrait_preview_url: previewExists ? `/api/nomination-videos/${nominationId}/portrait-preview` : null,
  };
};

export const loadPortraitReview = (nominationId: string, photoProvided: boolean) => {
  const status = portraitStatusFor({ photoProvided, nominationId });
  const paths = portraitPublicPaths(nominationId);
  const report = readJson(portraitReportPath(nominationId));
  return {
    portrait_status: status,
    portrait_url: paths.portrait_url,
    portrait_preview_url: paths.portrait_preview_url,
    portrait_report: summarizePortraitReport(report),
  };
};
