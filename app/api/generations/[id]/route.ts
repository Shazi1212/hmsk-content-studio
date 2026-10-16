import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { pickImageProvider } from "@/lib/providers";
import { errorResponse, withImageUrlList, zodIssues } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PatchSchema = z
  .object({
    status: z.enum(["draft", "approved", "rejected"]).optional(),
    notes: z.string().max(5000).nullable().optional(),
    audioUrl: z.string().max(4000).nullable().optional(),
    audioProvider: z.string().max(100).nullable().optional(),
    videoUrl: z.string().max(4000).nullable().optional(),
    videoProvider: z.string().max(100).nullable().optional(),
    imageUrl: z.string().max(4000).nullable().optional(),
    imageUrls: z.array(z.url({ protocol: /^https?$/ }).max(4000)).max(20).optional(),
    imageProvider: z.string().max(100).nullable().optional(),
    score: z.number().int().min(1).max(10).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "Provide at least one field to update." });

export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    const gen = await prisma.generation.findUnique({ where: { id }, include: { brand: { select: { slug: true, name: true } } } });
    if (!gen) return NextResponse.json({ error: "Generation not found." }, { status: 404 });
    return NextResponse.json(withImageUrlList(gen));
  } catch (err) {
    return errorResponse(err, "api/generations/[id] GET");
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update.", issues: zodIssues(parsed.error), code: "validation" }, { status: 422 });
  }
  const patch = parsed.data;

  try {
    const existing = await prisma.generation.findUnique({ where: { id }, select: { status: true } });
    if (!existing) return NextResponse.json({ error: "Generation not found." }, { status: 404 });

    const { imageUrls, ...rest } = patch;
    const data: Prisma.GenerationUpdateInput = { ...rest };
    if (imageUrls) {
      data.imageUrls = imageUrls.length ? JSON.stringify(imageUrls) : null;
      if (imageUrls.length && patch.imageUrl === undefined) data.imageUrl = imageUrls[0];
    }
    if (patch.status === "approved" && existing.status !== "approved") data.approvedAt = new Date();
    if (patch.status && patch.status !== "approved") data.approvedAt = null;
    if (patch.audioUrl && patch.audioProvider === undefined) data.audioProvider = "elevenlabs";
    if (patch.videoUrl && patch.videoProvider === undefined) data.videoProvider = "higgsfield";
    if ((patch.imageUrl || imageUrls?.length) && patch.imageProvider === undefined) data.imageProvider = pickImageProvider() ?? "image";

    const updated = await prisma.generation.update({ where: { id }, data });
    return NextResponse.json(withImageUrlList(updated));
  } catch (err) {
    return errorResponse(err, "api/generations/[id] PATCH");
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    const { count } = await prisma.generation.deleteMany({ where: { id } });
    if (count === 0) return NextResponse.json({ error: "Generation not found." }, { status: 404 });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return errorResponse(err, "api/generations/[id] DELETE");
  }
}
