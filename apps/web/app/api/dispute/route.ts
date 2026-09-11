import { NextResponse } from "next/server";
import { requireWallet } from "@/lib/privyServer";
import { readPosition } from "@/lib/contracts";
import { raiseDispute } from "@/lib/salary";

export const runtime = "nodejs";

/**
 * Contests a termination on the employee's behalf.
 *
 * Relayed on purpose. `raiseDispute` accepts the employee or a dispute relayer precisely
 * because someone who has just been dismissed is the person least likely to hold gas, and
 * a right of appeal that requires a funded wallet is a right in name only. Delegating is
 * safe in the strict sense: raising a dispute can only DELAY a forfeiture, never cause one.
 */
export async function POST(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // The grant comes from the verified wallet, not the request body. Otherwise anyone could
  // raise a dispute on anybody's grant -- harmless to the owner, but it would let a stranger
  // freeze an issuer's clawback indefinitely.
  const position = await readPosition(auth.wallet);
  if (!position.hasGrant || position.grantId === null) {
    return NextResponse.json({ error: "You have no grant to contest." }, { status: 400 });
  }
  if (!position.termination.terminated) {
    return NextResponse.json({ error: "This grant has not been terminated." }, { status: 400 });
  }
  if (position.termination.dispute !== 0) {
    return NextResponse.json({ error: "This termination has already been contested." }, { status: 400 });
  }
  if (!position.termination.canDispute) {
    return NextResponse.json(
      { error: "The window to contest this termination has closed." },
      { status: 400 },
    );
  }

  try {
    const hash = await raiseDispute(position.grantId);
    return NextResponse.json({ hash, grantId: position.grantId });
  } catch (err) {
    console.error("Dispute failed", err);
    return NextResponse.json({ error: "Could not file the appeal. Try again shortly." }, { status: 502 });
  }
}
