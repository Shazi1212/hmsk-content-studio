import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE → removes one idea batch from the history. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    const { count } = await prisma.ideaBatch.deleteMany({ where: { id } });
    if (count === 0) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "api/ideas/[id] DELETE");
  }
}
