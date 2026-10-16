import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { DraftGenerationSchema, errorResponse, flattenOutput, withImageUrlList, zodIssues } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SaveSchema = z.object({
  draft: DraftGenerationSchema,
  status: z.enum(["draft", "approved", "rejected"]).optional(),
  notes: z.string().max(5000).optional(),
});

const LIST_SELECT = {
  id: true,
  brandId: true,
  brand: { select: { slug: true, name: true } },
  platform: true,
  postType: true,
  status: true,
  brief: true,
  provider: true,
  model: true,
  output: true,
  score: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  notes: true,
  audioUrl: true,
  videoUrl: true,
  imageUrl: true,
  imageUrls: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.GenerationSelect;

function hookOf(output: unknown): string {
  const o = output as { variants?: { hook?: unknown }[] } | null;
  const hook = o?.variants?.[0]?.hook;
  return typeof hook === "string" ? hook : "";
}

/** POST {draft, status?, notes?} → saves a draft (approve = status "approved" + approvedAt). */
export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON: {draft, status?, notes?}." }, { status: 400 });
  }
  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid draft.", issues: zodIssues(parsed.error), code: "validation" }, { status: 422 });
  }
  const { draft, notes } = parsed.data;
  const status = parsed.data.status ?? draft.status ?? "draft";

  try {
    // The brand id in the draft must belong to the brand slug in the brief (both come from the client).
    const brand = await prisma.brand.findUnique({ where: { slug: draft.brief.brandSlug }, select: { id: true } });
    if (!brand) return NextResponse.json({ error: `Unknown brand "${draft.brief.brandSlug}".` }, { status: 422 });
    if (brand.id !== draft.brandId) {
      return NextResponse.json({ error: "draft.brandId does not match brief.brandSlug." }, { status: 422 });
    }

    const outputText = draft.outputText.trim() ? draft.outputText : flattenOutput(draft.output, draft.brief);
    const saved = await prisma.generation.create({
      data: {
        brandId: brand.id,
        platform: draft.platform,
        postType: draft.postType,
        status,
        brief: draft.brief,
        systemPrompt: draft.systemPrompt,
        userPrompt: draft.userPrompt,
        provider: draft.provider,
        model: draft.model,
        output: draft.output,
        outputText,
        referenceIds: draft.referenceIds,
        priorGenIds: draft.priorGenIds,
        audioUrl: draft.audioUrl,
        audioProvider: draft.audioProvider,
        videoUrl: draft.videoUrl,
        videoProvider: draft.videoProvider,
        imageUrl: draft.imageUrl ?? draft.imageUrls[0] ?? null,
        imageUrls: draft.imageUrls.length ? JSON.stringify(draft.imageUrls) : null,
        imageProvider: draft.imageProvider,
        score: draft.score,
        inputTokens: draft.inputTokens,
        outputTokens: draft.outputTokens,
        cacheReadTokens: draft.cacheReadTokens,
        notes: notes ?? draft.notes,
        approvedAt: status === "approved" ? new Date() : null,
      },
    });
    return NextResponse.json(withImageUrlList(saved), { status: 201 });
  } catch (err) {
    return errorResponse(err, "api/generations POST");
  }
}

/** GET ?brandSlug=&status=&limit= → newest first. */
export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const brandSlug = sp.get("brandSlug")?.trim() || undefined;
  const statusParam = sp.get("status")?.trim() || undefined;
  const status = statusParam && ["draft", "approved", "rejected"].includes(statusParam) ? statusParam : undefined;
  if (statusParam && !status) {
    return NextResponse.json({ error: "status must be draft | approved | rejected." }, { status: 422 });
  }
  const limitRaw = Number.parseInt(sp.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;

  try {
    const rows = await prisma.generation.findMany({
      where: { ...(brandSlug ? { brand: { slug: brandSlug } } : {}), ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: LIST_SELECT,
    });
    return NextResponse.json({
      generations: rows.map((g) => ({ ...withImageUrlList(g), hook: hookOf(g.output) })),
      count: rows.length,
    });
  } catch (err) {
    return errorResponse(err, "api/generations GET");
  }
}
