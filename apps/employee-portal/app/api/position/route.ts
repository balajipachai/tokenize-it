import { NextResponse } from "next/server";
import { requireWallet } from "@/lib/privyServer";
import { readPosition } from "@/lib/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) {
    // `code` lets the client tell "your wallet is still being created" (retry, show a
    // spinner) apart from "your session is bad" (show an error). Without it a brand-new
    // account flashes a scary red banner for the second before Privy finishes.
    return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
  }

  try {
    return NextResponse.json(await readPosition(auth.wallet));
  } catch (err) {
    console.error("Reading position failed", err);
    return NextResponse.json({ error: "Could not read your equity right now." }, { status: 502 });
  }
}
