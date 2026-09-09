import { NextResponse } from "next/server";
import { requireWallet } from "@/lib/privyServer";
import { readPosition, submitClaim } from "@/lib/contracts";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Read the grant from the verified wallet rather than trusting a grantId from the
  // body -- otherwise anyone could pass someone else's id. releaseVested is
  // permissionless on-chain, so this is about correctness rather than authority.
  const position = await readPosition(auth.wallet);
  if (!position.hasGrant || position.grantId === null) {
    return NextResponse.json({ error: "You have no grant to claim from." }, { status: 400 });
  }
  if (position.claimable === 0) {
    return NextResponse.json({ error: "Nothing has vested yet." }, { status: 400 });
  }

  try {
    // Returns once the transaction is submitted, not once it is mined, so the client
    // can show the HashScan link while it confirms. The client polls for settlement.
    const hash = await submitClaim(position.grantId);
    return NextResponse.json({ hash, grantId: position.grantId });
  } catch (err) {
    console.error("Claim failed", err);
    return NextResponse.json({ error: "The claim did not go through. Try again shortly." }, { status: 502 });
  }
}
