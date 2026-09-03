/** TypeScript port of scripts/applyApprovedPortraitCrop.py. No Python on Vercel. */

import { createHash } from "crypto";
import { PNG } from "pngjs";

export const CROP_VERSION = "top60_y1372";

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const WELL_CX = 485;
const PHOTO_AREA_BOTTOM = 1372;
const ALPHA_T = 16;
const SCALE = 1.0;
const KEEP_TOP_RATIO = 0.6;

export type CropGeometry = {
  scale: number;
  keep_top_ratio: number;
  canvas_keep_height: number;
  canvas_removed_bottom_px: number;
  x: number;
  y: number;
  sprite_width: number;
  sprite_height: number;
  source_bbox: number[];
  visible_bottom: number;
  visible_top: number;
  visible_left: number;
  visible_right: number;
  clear: number;
  opaque255: number;
  partial: number;
  size: number[];
  mode: string;
  pixels_unchanged: boolean;
  second_translation: boolean;
};

const idx = (x: number, y: number, width: number) => (y * width + x) * 4;

const alphaAt = (data: Buffer | Uint8Array, x: number, y: number, width: number) =>
  data[idx(x, y, width) + 3];

const bboxOf = (
  data: Buffer | Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): [number, number, number, number] | null => {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  let found = false;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (alphaAt(data, x, y, width) < ALPHA_T) continue;
      found = true;
      if (x < left) left = x;
      if (y < top) top = y;
      if (x + 1 > right) right = x + 1;
      if (y + 1 > bottom) bottom = y + 1;
    }
  }
  return found ? [left, top, right, bottom] : null;
};

const copyRect = (
  src: Buffer | Uint8Array,
  srcW: number,
  srcH: number,
  dest: Buffer,
  destW: number,
  destH: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number
) => {
  for (let y = 0; y < sh; y++) {
    const srcY = sy + y;
    const destY = dy + y;
    if (srcY < 0 || destY < 0 || srcY >= srcH || destY >= destH) continue;
    for (let x = 0; x < sw; x++) {
      const srcX = sx + x;
      const destX = dx + x;
      if (srcX < 0 || destX < 0 || srcX >= srcW || destX >= destW) continue;
      const si = idx(srcX, srcY, srcW);
      const di = idx(destX, destY, destW);
      dest[di] = src[si];
      dest[di + 1] = src[si + 1];
      dest[di + 2] = src[si + 2];
      dest[di + 3] = src[si + 3];
    }
  }
};

const spriteBytes = (data: Buffer | Uint8Array, width: number, x0: number, y0: number, sw: number, sh: number) => {
  const out = Buffer.alloc(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const si = idx(x0 + x, y0 + y, width);
      const di = (y * sw + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return out;
};

const hashBytes = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** OpenAI returns 1088×1920; the approved crop is 1080×1920. Center-crop 4px each side. */
export const toApprovedCanvas = (png: PNG): PNG => {
  if (png.width === CANVAS_W && png.height === CANVAS_H) return png;
  if (png.width === 1088 && png.height === CANVAS_H) {
    const out = new PNG({ width: CANVAS_W, height: CANVAS_H });
    copyRect(png.data, png.width, png.height, out.data as Buffer, CANVAS_W, CANVAS_H, 4, 0, CANVAS_W, CANVAS_H, 0, 0);
    return out;
  }
  throw new Error(`expected ${CANVAS_W}x${CANVAS_H} or 1088x${CANVAS_H}, got ${png.width}x${png.height}`);
};

export const cropPortraitPng = (input: Buffer): { png: Buffer; geometry: CropGeometry } => {
  const src = toApprovedCanvas(PNG.sync.read(input));
  if (src.width !== CANVAS_W || src.height !== CANVAS_H) {
    throw new Error(`expected ${CANVAS_W}x${CANVAS_H}, got ${src.width}x${src.height}`);
  }

  const keepH = Math.round(CANVAS_H * KEEP_TOP_RATIO);
  if (keepH <= 0 || keepH >= CANVAS_H) throw new Error(`invalid keep-top height ${keepH}`);

  const bbox = bboxOf(src.data, src.width, src.height, 0, 0, CANVAS_W, keepH);
  if (!bbox) throw new Error("empty teacher silhouette after top-60 crop");
  const [bl, bt, br, bb] = bbox;
  const sw = br - bl;
  const sh = bb - bt;
  if (sw > CANVAS_W) throw new Error(`sprite width ${sw} exceeds canvas width ${CANVAS_W}`);
  // Centering on the well pushes wide silhouettes past the left edge, which would
  // silently clip the teacher. Slide it back on-canvas instead of losing pixels.
  const x = Math.min(Math.max(Math.round(WELL_CX - sw / 2), 0), CANVAS_W - sw);
  const y = PHOTO_AREA_BOTTOM - sh;
  if (y < 0) throw new Error(`sprite height ${sh} exceeds photo-area bottom ${PHOTO_AREA_BOTTOM}`);

  const canvas = new PNG({ width: CANVAS_W, height: CANVAS_H });
  (canvas.data as Buffer).fill(0);
  copyRect(src.data, src.width, src.height, canvas.data as Buffer, CANVAS_W, CANVAS_H, bl, bt, sw, sh, x, y);

  const vis = bboxOf(canvas.data, CANVAS_W, CANVAS_H, 0, 0, CANVAS_W, CANVAS_H);
  if (!vis) throw new Error("cropped canvas is empty");

  let clear = 0;
  let opaque255 = 0;
  let partial = 0;
  const pixels = CANVAS_W * CANVAS_H;
  for (let i = 0; i < pixels; i++) {
    const a = canvas.data[i * 4 + 3];
    if (a === 0) clear += 1;
    else if (a === 255) opaque255 += 1;
    else partial += 1;
  }

  const srcHash = hashBytes(spriteBytes(src.data, src.width, bl, bt, sw, sh));
  const outHash = hashBytes(spriteBytes(canvas.data, CANVAS_W, vis[0], vis[1], vis[2] - vis[0], vis[3] - vis[1]));
  if (srcHash !== outHash) throw new Error("teacher pixels changed during crop");
  if (vis[3] !== PHOTO_AREA_BOTTOM) throw new Error(`visible bottom ${vis[3]} != ${PHOTO_AREA_BOTTOM}`);
  if (vis[0] !== x || vis[1] !== y) {
    throw new Error(`paste mismatch x,y expected (${x}, ${y}) got (${vis[0]}, ${vis[1]})`);
  }

  return {
    png: PNG.sync.write(canvas),
    geometry: {
      scale: SCALE,
      keep_top_ratio: KEEP_TOP_RATIO,
      canvas_keep_height: keepH,
      canvas_removed_bottom_px: CANVAS_H - keepH,
      x,
      y,
      sprite_width: sw,
      sprite_height: sh,
      source_bbox: [bl, bt, br, bb],
      visible_bottom: vis[3],
      visible_top: vis[1],
      visible_left: vis[0],
      visible_right: vis[2],
      clear,
      opaque255,
      partial,
      size: [CANVAS_W, CANVAS_H],
      mode: "RGBA",
      pixels_unchanged: true,
      second_translation: false,
    },
  };
};
