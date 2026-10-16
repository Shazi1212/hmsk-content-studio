/**
 * Browser-side preparation of a reference photo before upload: the long edge is scaled down to 1600 px and the file is
 * re-encoded under about 1.5 MB, because the host's proxy may reject large request bodies. PNGs with transparency (logos)
 * stay PNG when they fit; everything else becomes JPEG.
 */

export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_EDGE = 1600;
export const TARGET_BYTES = 1.5 * 1024 * 1024;
/** Source files above this are refused before decoding (a decoded 50 MB photo already needs hundreds of MB of memory). */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export type PreparedImage = {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  /** False when the original file was already small enough and is uploaded as it is. */
  changed: boolean;
};

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      /* fall back to an <img> element below */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("This file could not be read as an image.");
  }
}

function draw(source: CanvasImageSource, width: number, height: number, background?: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot resize images.");
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("This browser could not encode the image."))), type, quality);
  });
}

const baseName = (name: string): string => name.replace(/\.[^./\\]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 80) || "photo";

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new Error("Only PNG, JPEG or WebP images can be used.");
  const img = await decode(file);
  try {
    const longEdge = Math.max(img.width, img.height);
    if (!longEdge) throw new Error("This image has no pixels.");
    if (longEdge <= MAX_EDGE && file.size <= TARGET_BYTES) {
      return { blob: file, filename: file.name, width: img.width, height: img.height, changed: false };
    }

    const scale = Math.min(1, MAX_EDGE / longEdge);
    let width = Math.max(1, Math.round(img.width * scale));
    let height = Math.max(1, Math.round(img.height * scale));
    const name = baseName(file.name);

    // A PNG (or WebP) with transparency, typically a logo, keeps its alpha channel as PNG when it fits.
    if (file.type !== "image/jpeg") {
      const plain = draw(img.source, width, height);
      if (hasTransparency(plain)) {
        const png = await toBlob(plain, "image/png");
        if (png.size <= TARGET_BYTES) return { blob: png, filename: `${name}.png`, width, height, changed: true };
      }
    }

    // Everything else is JPEG on a white background (JPEG has no alpha); lower quality, then size, until it fits.
    let canvas = draw(img.source, width, height, "#ffffff");
    let blob = await toBlob(canvas, "image/jpeg", 0.88);
    for (const quality of [0.8, 0.7, 0.6]) {
      if (blob.size <= TARGET_BYTES) break;
      blob = await toBlob(canvas, "image/jpeg", quality);
    }
    for (let round = 0; blob.size > TARGET_BYTES && Math.max(width, height) > 800 && round < 4; round++) {
      width = Math.round(width * 0.85);
      height = Math.round(height * 0.85);
      canvas = draw(img.source, width, height, "#ffffff");
      blob = await toBlob(canvas, "image/jpeg", 0.7);
    }
    return { blob, filename: `${name}.jpg`, width, height, changed: true };
  } finally {
    img.close();
  }
}
