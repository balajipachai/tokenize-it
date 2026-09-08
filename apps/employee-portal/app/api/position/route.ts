import { NextResponse } from "next/server";
import { requireWallet } from "@/lib/privyServer";
import { readPosition } from "@/lib/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    return NextResponse.json(await readPosition(auth.wallet));
  } catch (err) {
    console.error("Reading position failed", err);
    return NextResponse.json({ error: "Could not read your equity right now." }, { status: 502 });
  }
}
