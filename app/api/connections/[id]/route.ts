import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE → forgets the account: the stored (encrypted) tokens are deleted; already imported posts stay in the research data. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    const { count } = await prisma.platformConnection.deleteMany({ where: { id } });
    if (count === 0) return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "api/connections/[id] DELETE");
  }
}
