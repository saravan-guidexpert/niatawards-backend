/** Source-photo decision is Nomination.photo_url only. Portrait existence is a separate state. */

export const hasSourcePhoto = (photoUrl: unknown): boolean => {
  const value = String(photoUrl ?? "").trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export const intendedVideoCategory = (photoUrl: unknown): "with_photo" | "without_photo" =>
  hasSourcePhoto(photoUrl) ? "with_photo" : "without_photo";
