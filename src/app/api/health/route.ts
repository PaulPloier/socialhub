import { NextResponse } from "next/server";
import { dbKind, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb();
    return NextResponse.json({ ok: true, db: dbKind() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
