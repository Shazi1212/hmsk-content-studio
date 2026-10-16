/**
 * Key visual generation: OpenAI images (default) or the Gemini image model, chosen by pickImageProvider() in config.ts.
 *
 *  OpenAI  POST {OPENAI_BASE_URL}/images/generations  {model: OPENAI_IMAGE_MODEL (default gpt-image-2), prompt, size, quality,
 *          output_format: "jpeg"} → data[0].b64_json. gpt-image-2 takes any size whose edges are multiples of 16, so 9:16 is
 *          really 1024x1824 (not the 2:3 of older models); a size rejection retries with the classic 1024x1536 / 1536x1024.
 *          Env: OPENAI_API_KEY (shared with the text provider), OPENAI_IMAGE_MODEL, OPENAI_IMAGE_QUALITY (low | medium | high |
 *          auto, default medium).
 *  Gemini  POST …/v1beta/models/{GEMINI_IMAGE_MODEL}:generateContent (default gemini-2.5-flash-image) → first `inlineData`
 *          part (base64). Needs a billing-enabled key: the free tier answers 429 with "limit: 0" for image models.
 *          Env: GEMINI_API_KEY, GEMINI_IMAGE_MODEL.
 *  IMAGE_PROVIDER=openai|gemini forces one.
 *  References: with input.references (the brand's logo, product, packaging, people and mood images, at most 4) OpenAI uses
 *  POST /images/edits (multipart, image[]) and Gemini puts them as inlineData parts before the text part; both get a short
 *  instruction first that says what each kind of reference is for (reproduce the product, the only logo, a person, style only).
 */
import type { ReferenceKind } from "@/lib/reference-kinds";
import {
  PROVIDER_DEFAULTS,
  PROVIDER_TIMEOUTS,
  ProviderNotConfiguredError,
  ProviderRequestError,
  envOr,
  geminiGenerateContentUrl,
  geminiHeaders,
  pickImageProvider,
  providerFetch,
  readErrorBody,
  readJsonBody,
  requireEnv,
  shortText,
  trimBaseUrl,
  type GeminiGenerateContentResponse,
  type ImageProviderId,
} from "./config";

export type ImageReference = { bytes: Uint8Array; mime: string; label: string; kind: ReferenceKind };
export type GenerateImageInput = { prompt: string; aspectRatio?: string; references?: ImageReference[] };
export type GenerateImageResult = { bytes: Uint8Array; mime: string; provider: ImageProviderId; model: string };

/** Aspect ratios accepted by the Gemini image models' imageConfig. */
const ASPECT_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const PROVIDER = "gemini-image";

/** What the image model does with one reference image, by kind. */
const REFERENCE_KIND_RULES: Record<ReferenceKind, string> = {
  product:
    "Reproduce this exact product (shape, materials, colour of the contents, printed logo) faithfully whenever the product appears; where the prompt describes the product differently from the reference (for example the colour of what is inside the jar), the reference wins.",
  packaging:
    "Reproduce this exact packaging (shape, material, colours, printed label) faithfully whenever packaging appears; where the prompt describes it differently, the reference wins.",
  logo: "This is the brand's logo: reproduce it exactly wherever a logo is placed; it is the only logo allowed.",
  person:
    "This person may appear only if the prompt asks for a person; then show them as in this reference and never invent a different face for them. Leave them out when the prompt shows no person.",
  mood: "Style reference only: take its colour palette, lighting, atmosphere and composition feel; do not copy its content, objects, people or any text.",
  other: "General reference for the brand's look; use it as the prompt directs and do not copy text from it.",
};

/** Short instruction that precedes the prompt when reference images are attached. */
function referenceInstruction(refs: ImageReference[]): string {
  const lines = refs.map((r, i) => `Reference image ${i + 1} (${r.kind}): ${r.label.replace(/\s+/g, " ").replace(/[.\s]+$/, "")}. ${REFERENCE_KIND_RULES[r.kind] ?? REFERENCE_KIND_RULES.other}`);
  return `${lines.join("\n")}\nDo not invent other packaging, logos or brand marks. Never add words, numbers, prices, discounts, strike-through prices or product claims that the prompt does not quote; text on the reference images is not to be copied apart from the logo and the printed label.\n\n`;
}

function decodeBase64(data: string): Uint8Array {
  const buf = Buffer.from(data, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export async function generateImage(p: GenerateImageInput): Promise<GenerateImageResult> {
  const provider = pickImageProvider();
  if (provider === "openai") return generateOpenAiImage(p);
  if (provider === "gemini") return generateGeminiImage(p);
  // Nothing configured (or the forced provider has no key): the "set …" error the UI turns into a hint.
  const gemini = envOr("IMAGE_PROVIDER", "").toLowerCase() === "gemini";
  throw new ProviderNotConfiguredError(gemini ? "gemini" : "openai", [gemini ? "GEMINI_API_KEY" : "OPENAI_API_KEY"], "Key visuals use OpenAI images by default, or Gemini with IMAGE_PROVIDER=gemini.");
}

// ---------------------------------------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------------------------------------

const OPENAI_PROVIDER = "openai-image";
const OPENAI_QUALITIES = new Set(["low", "medium", "high", "auto"]);
/** Classic sizes every gpt-image model accepts; used when a flexible size is rejected. */
const OPENAI_FALLBACK_SIZES: Record<string, string> = { portrait: "1024x1536", landscape: "1536x1024", square: "1024x1024" };

/**
 * Pixel size for an aspect ratio: the short edge is 1024 and the long edge follows the ratio in steps of 16 (gpt-image-2 accepts any
 * size with edges that are multiples of 16, up to 3:1). 9:16 is 1024x1824, 4:5 is 1024x1280, 16:9 is 1824x1024, 1:1 is 1024x1024:
 * about the native resolution of the platforms, and the price grows with the pixel count.
 */
export function openAiImageSize(aspectRatio: string | undefined): { size: string; shape: "portrait" | "landscape" | "square" } {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec((aspectRatio ?? "").trim());
  const w = m ? Number(m[1]) : 1;
  const h = m ? Number(m[2]) : 1;
  if (!m || w === 0 || h === 0 || Math.max(w, h) / Math.min(w, h) > 3 || w === h) return { size: "1024x1024", shape: "square" };
  const long = Math.round((1024 * Math.max(w, h)) / Math.min(w, h) / 16) * 16;
  return w < h ? { size: `1024x${long}`, shape: "portrait" } : { size: `${long}x1024`, shape: "landscape" };
}

type OpenAiImageResponse = { data?: { b64_json?: unknown }[]; error?: { message?: string } };

async function generateOpenAiImage(p: GenerateImageInput): Promise<GenerateImageResult> {
  const { OPENAI_API_KEY: apiKey } = requireEnv("openai", ["OPENAI_API_KEY"], "Key visuals use the OpenAI key that also serves the text models.");
  const model = envOr("OPENAI_IMAGE_MODEL", PROVIDER_DEFAULTS.openaiImageModel);
  const quality = envOr("OPENAI_IMAGE_QUALITY", "medium").toLowerCase();
  const prompt = (p.prompt ?? "").trim();
  if (!prompt) throw new ProviderRequestError(OPENAI_PROVIDER, 400, "prompt is empty: generate an image prompt first");

  const refs = p.references ?? [];
  const base = trimBaseUrl(envOr("OPENAI_BASE_URL", PROVIDER_DEFAULTS.openaiBaseUrl));
  const url = `${base}/${refs.length ? "images/edits" : "images/generations"}`;
  const { size, shape } = openAiImageSize(p.aspectRatio);
  const fullPrompt = (refs.length ? referenceInstruction(refs) + prompt : prompt).slice(0, 4000);
  const q = OPENAI_QUALITIES.has(quality) ? quality : "medium";
  const request = (useSize: string) => {
    if (refs.length) {
      // Edits endpoint: multipart with several reference files (gpt-image models accept up to 16). No content-type header: fetch adds the boundary.
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", fullPrompt);
      form.append("size", useSize);
      form.append("quality", q);
      form.append("output_format", "jpeg");
      form.append("output_compression", "90");
      refs.forEach((r, i) => {
        const ab = new ArrayBuffer(r.bytes.byteLength);
        new Uint8Array(ab).set(r.bytes);
        const ext = r.mime.split("/")[1] ?? "png";
        form.append("image[]", new Blob([ab], { type: r.mime }), `reference-${i + 1}-${r.kind}.${ext}`);
      });
      return providerFetch(OPENAI_PROVIDER, url, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form }, PROVIDER_TIMEOUTS.image);
    }
    return providerFetch(
      OPENAI_PROVIDER,
      url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: fullPrompt, n: 1, size: useSize, quality: q, output_format: "jpeg", output_compression: 90 }),
      },
      PROVIDER_TIMEOUTS.image,
    );
  };

  let res = await request(size);
  if (res.status === 400) {
    const firstError = await readErrorBody(res);
    if (!/size|resolution|dimension/i.test(firstError)) throw new ProviderRequestError(OPENAI_PROVIDER, 400, firstError);
    res = await request(OPENAI_FALLBACK_SIZES[shape]);
    if (!res.ok) throw new ProviderRequestError(OPENAI_PROVIDER, res.status, `${await readErrorBody(res)} (first attempt: ${shortText(firstError, 200)})`);
  }
  if (!res.ok) throw new ProviderRequestError(OPENAI_PROVIDER, res.status, await readErrorBody(res));

  const data = await readJsonBody<OpenAiImageResponse>(OPENAI_PROVIDER, res);
  const b64 = data.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) {
    throw new ProviderRequestError(OPENAI_PROVIDER, 502, `no image in the response${data.error?.message ? `: ${shortText(data.error.message, 300)}` : ""}`);
  }
  const bytes = decodeBase64(b64);
  if (bytes.byteLength === 0) throw new ProviderRequestError(OPENAI_PROVIDER, 502, "image data was empty");
  return { bytes, mime: "image/jpeg", provider: "openai", model };
}

// ---------------------------------------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------------------------------------

async function generateGeminiImage(p: GenerateImageInput): Promise<GenerateImageResult> {
  const { GEMINI_API_KEY: apiKey } = requireEnv("gemini", ["GEMINI_API_KEY"], "The image model uses the same key as the Gemini text provider.");
  const model = envOr("GEMINI_IMAGE_MODEL", PROVIDER_DEFAULTS.geminiImageModel);

  const prompt = (p.prompt ?? "").trim();
  if (!prompt) throw new ProviderRequestError(PROVIDER, 400, "prompt is empty: generate an image prompt first");
  const aspectRatio = (p.aspectRatio ?? "").trim();
  const validAspect = ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : undefined;

  const url = geminiGenerateContentUrl(model);
  const headers = geminiHeaders(apiKey);

  const refs = p.references ?? [];
  const refParts = refs.map((r) => ({ inlineData: { mimeType: r.mime, data: Buffer.from(r.bytes).toString("base64") } }));
  const text = refs.length ? referenceInstruction(refs) + prompt : prompt;
  const primaryBody = {
    contents: [{ role: "user", parts: [...refParts, { text }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      ...(validAspect ? { imageConfig: { aspectRatio: validAspect } } : {}),
    },
  };
  // Fallback for models / API versions that reject image-only modalities or imageConfig.
  const compatBody = {
    contents: [
      { role: "user", parts: [...refParts, { text: validAspect ? `${text}\n\nAspect ratio: ${validAspect}.` : text }] },
    ],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  let res = await providerFetch(PROVIDER, url, { method: "POST", headers, body: JSON.stringify(primaryBody) }, PROVIDER_TIMEOUTS.image);
  if (res.status === 400) {
    const firstError = await readErrorBody(res);
    res = await providerFetch(PROVIDER, url, { method: "POST", headers, body: JSON.stringify(compatBody) }, PROVIDER_TIMEOUTS.image);
    if (!res.ok) {
      const secondError = await readErrorBody(res);
      throw new ProviderRequestError(PROVIDER, res.status, `${secondError} (first attempt: ${shortText(firstError, 200)})`);
    }
  }
  if (!res.ok) throw new ProviderRequestError(PROVIDER, res.status, await readErrorBody(res));

  const data = await readJsonBody<GeminiGenerateContentResponse>(PROVIDER, res);
  if (data.error?.message) throw new ProviderRequestError(PROVIDER, data.error.code ?? 502, data.error.message);
  if (data.promptFeedback?.blockReason) {
    throw new ProviderRequestError(
      PROVIDER,
      502,
      `prompt blocked (${data.promptFeedback.blockReason}). Rephrase the image prompt (no real people, brands or medical claims).`,
    );
  }

  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const imagePart = parts.find((part) => part.inlineData && typeof part.inlineData.data === "string" && part.inlineData.data.length > 0);
  if (!imagePart?.inlineData?.data) {
    const textPart = parts.find((part) => typeof part.text === "string" && part.text.trim())?.text;
    throw new ProviderRequestError(
      PROVIDER,
      502,
      `no image in response (finishReason: ${candidate?.finishReason ?? "none"})${textPart ? `: ${shortText(textPart, 300)}` : ""}`,
    );
  }

  const bytes = decodeBase64(imagePart.inlineData.data);
  if (bytes.byteLength === 0) throw new ProviderRequestError(PROVIDER, 502, "image data was empty");
  const mime = imagePart.inlineData.mimeType && imagePart.inlineData.mimeType.startsWith("image/") ? imagePart.inlineData.mimeType : "image/png";

  return { bytes, mime, provider: "gemini", model: data.modelVersion ?? model };
}
