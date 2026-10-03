import { CATEGORY_ICON_DISPLAY_NAMES, categoryIconLabel } from "./categoryIcons";
import { isSubmittedNomination } from "./nominationKind";
import { phone10 } from "./resolveTeacherPortrait";
import type { MomentoTeacher } from "../data/karnatakaMomentoTeachers";

export type MomentoNominationInput = {
  _id: unknown;
  phone?: unknown;
  status?: unknown;
};

export type MomentoVideoInput = {
  nomination_id?: unknown;
  category_icon_filename?: unknown;
  video_url?: unknown;
  generated_at?: Date | string | null;
  generation_status?: unknown;
};

export type MomentoVideoView = {
  nomination_id: string;
  video_url: string | null;
  category_icon_label: string | null;
  generated_at: string | null;
};

export type MomentoRow = {
  id: string;
  name: string;
  phone: string;
  region: string;
  matched: boolean;
  video_count: number;
  momentos: string[];
  videos: MomentoVideoView[];
};

const storedMomentoLabel = (filename: unknown) => {
  const raw = String(filename ?? "").trim();
  if (!raw) return null;
  const label = categoryIconLabel(raw);
  return label === "Not selected" ? null : label;
};

const isoDate = (value: Date | string | null | undefined) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const videoTime = (value: Date | string | null | undefined) => {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

const FALLBACK_MOMENTOS = Object.values(CATEGORY_ICON_DISPLAY_NAMES);

/** Stable across requests so a teacher keeps the same assigned momento. */
const fallbackMomento = (teacher: MomentoTeacher, index: number) => {
  const seed = `${teacher.region}|${teacher.name}|${teacher.phone}|${index}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_MOMENTOS[hash % FALLBACK_MOMENTOS.length];
};

export const buildMomentoRows = (
  roster: MomentoTeacher[],
  nominations: MomentoNominationInput[],
  videos: MomentoVideoInput[]
): MomentoRow[] => {
  const videosByNomination = new Map<string, MomentoVideoInput[]>();
  for (const video of videos) {
    const nominationId = String(video.nomination_id || "").trim();
    if (!nominationId) continue;
    const list = videosByNomination.get(nominationId) || [];
    list.push(video);
    videosByNomination.set(nominationId, list);
  }

  const nominationsByPhone = new Map<string, MomentoNominationInput[]>();
  for (const nomination of nominations) {
    if (!isSubmittedNomination(nomination)) continue;
    const phone = phone10(nomination.phone);
    if (phone.length !== 10) continue;
    const list = nominationsByPhone.get(phone) || [];
    list.push(nomination);
    nominationsByPhone.set(phone, list);
  }

  return roster.map((teacher, index) => {
    const phone = phone10(teacher.phone);
    const matchedNominations = phone.length === 10 ? nominationsByPhone.get(phone) || [] : [];
    const matchedVideos = matchedNominations.flatMap((nomination) => {
      const nominationId = String(nomination._id || "").trim();
      return videosByNomination.get(nominationId) || [];
    });

    const generated = matchedVideos
      .filter((video) => String(video.generation_status || "") === "generated" || Boolean(String(video.video_url || "").trim()))
      .sort((a, b) => videoTime(a.generated_at) - videoTime(b.generated_at));

    const views: MomentoVideoView[] = generated.map((video) => ({
      nomination_id: String(video.nomination_id || "").trim(),
      video_url: String(video.video_url || "").trim() || null,
      category_icon_label: storedMomentoLabel(video.category_icon_filename),
      generated_at: isoDate(video.generated_at),
    }));

    const momento = [...views]
      .reverse()
      .map((video) => video.category_icon_label)
      .find((label): label is string => Boolean(label));
    const momentos = [momento || fallbackMomento(teacher, index)];

    return {
      id: `${teacher.region}-${phone || "no-phone"}-${index}`,
      name: teacher.name,
      phone,
      region: teacher.region,
      matched: matchedNominations.length > 0,
      video_count: views.length,
      momentos,
      videos: views,
    };
  });
};
