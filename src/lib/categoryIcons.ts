import { randomInt } from "crypto";
import fs from "fs";
import path from "path";
import { Resvg } from "@resvg/resvg-js";

export const CATEGORY_ICON_BOX = { x: 110, y: 155, w: 860, h: 220 };

export const categoryIconDir = (root: string) =>
  path.join(root, "assets", "teacher-student", "icons");

export const listCategoryIcons = (root: string) => {
  const dir = categoryIconDir(root);
  if (!fs.existsSync(dir)) throw new Error(`missing category icon directory: ${dir}`);
  const files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".svg")).sort();
  if (files.length !== 12) {
    throw new Error(`expected 12 category SVG icons, found ${files.length} in ${dir}`);
  }
  return files;
};

export type PickedCategoryIcon = {
  category_icon_id: string;
  category_icon_filename: string;
  svgPath: string;
};

const fromFilename = (root: string, filename: string): PickedCategoryIcon => ({
  category_icon_id: filename.replace(/\.svg$/i, ""),
  category_icon_filename: filename,
  svgPath: path.join(categoryIconDir(root), filename),
});

export const pickRandomCategoryIcon = (root: string): PickedCategoryIcon => {
  const files = listCategoryIcons(root);
  return fromFilename(root, files[randomInt(files.length)]);
};

export const resolveCategoryIcon = (
  root: string,
  existingFilename?: string | null
): PickedCategoryIcon => {
  const files = listCategoryIcons(root);
  const filename = String(existingFilename || "").trim();
  if (filename && files.includes(filename)) return fromFilename(root, filename);
  return pickRandomCategoryIcon(root);
};

export const categoryIconLabel = (filename: string | null | undefined) => {
  const stem = String(filename || "").replace(/\.svg$/i, "").trim();
  if (!stem) return "Not selected";
  return stem.replace(/-/g, " ");
};

const viewBoxSize = (svg: string) => {
  const match = svg.match(/viewBox=["']([^"']+)["']/i);
  if (!match) throw new Error("SVG is missing viewBox");
  const parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) {
    throw new Error(`invalid SVG viewBox: ${match[1]}`);
  }
  return { width: parts[2], height: parts[3] };
};

export const rasterizeCategoryIcon = (svgPath: string, destPng: string) => {
  const svg = fs.readFileSync(svgPath, "utf8");
  const box = viewBoxSize(svg);
  const scale = Math.min(CATEGORY_ICON_BOX.w / box.width, CATEGORY_ICON_BOX.h / box.height);
  const outW = Math.max(1, Math.round(box.width * scale));
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: outW },
    background: "rgba(0,0,0,0)",
  });
  const png = resvg.render().asPng();
  fs.mkdirSync(path.dirname(destPng), { recursive: true });
  fs.writeFileSync(destPng, png);
  return destPng;
};
