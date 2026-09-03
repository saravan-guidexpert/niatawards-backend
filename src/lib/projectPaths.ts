import fs from "fs";
import path from "path";

const exists = (file: string) => {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
};

const isBackendPackage = (dir: string) => {
  const pkg = path.join(dir, "package.json");
  if (!exists(pkg)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: unknown };
    return String(parsed.name || "").includes("backend");
  } catch {
    return false;
  }
};

let cachedBackendRoot = "";

export const backendRoot = () => {
  if (cachedBackendRoot) return cachedBackendRoot;
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), "backend"),
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname, "../../.."),
    path.resolve(__dirname, "../../../.."),
  ];
  const named = candidates.find((dir) => isBackendPackage(dir));
  if (named) {
    cachedBackendRoot = named;
    return named;
  }
  // Fall back to any ancestor that looks like a Node package so `dist/` builds still resolve.
  const anyPackage = candidates.find((dir) => exists(path.join(dir, "package.json")));
  cachedBackendRoot = anyPackage || process.cwd();
  return cachedBackendRoot;
};

export const loadBackendEnv = () => {
  const candidates = [
    path.join(backendRoot(), ".env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../.env"),
  ];
  for (const file of candidates) {
    if (exists(file)) return file;
  }
  return "";
};

const hasBgRemoveAssets = (dir: string) =>
  exists(path.join(dir, "assets", "teacher-student", "icons")) &&
  exists(path.join(dir, "generate_one_nomination.py"));

let cachedBgRemoveRoot = "";

export const bgRemoveRoot = () => {
  if (cachedBgRemoveRoot) return cachedBgRemoveRoot;
  const fromEnv = String(process.env.BG_REMOVE_ROOT || "").trim();
  const candidates = [
    ...(fromEnv ? [path.resolve(fromEnv)] : []),
    path.resolve(backendRoot(), "../bg-remove"),
    path.resolve(process.cwd(), "../bg-remove"),
    path.resolve(process.cwd(), "bg-remove"),
    path.resolve(__dirname, "../../../bg-remove"),
    path.resolve(__dirname, "../../../../bg-remove"),
  ];
  const found = candidates.find((dir) => hasBgRemoveAssets(dir));
  if (!found) {
    throw new Error(
      `bg-remove renderer assets not found. Set BG_REMOVE_ROOT to the bg-remove folder. Tried: ${candidates.join(", ")}`
    );
  }
  cachedBgRemoveRoot = found;
  return found;
};

export const teacherPortraitDir = () => path.join(bgRemoveRoot(), "output", "teacher-portraits");

export const nominationVideoDir = () => path.join(backendRoot(), "storage", "nomination-videos");

export const firstEnv = (...keys: string[]) => {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
};
