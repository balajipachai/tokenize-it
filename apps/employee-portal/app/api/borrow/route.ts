import { NextResponse } from "next/server";
import { parseUnits, type Hex } from "viem";
import { requireWallet } from "@/lib/privyServer";
import { buildPledge, readBorrowing, relayBorrow } from "@/lib/lending";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current borrowing capacity for the signed-in employee. */
export async function GET(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
  try {
    return NextResponse.json(await readBorrowing(auth.wallet));
  } catch (err) {
    console.error("Reading borrowing state failed", err);
    return NextResponse.json({ error: "Could not read the lending pool right now." }, { status: 502 });
  }
}

/**
 * Two-step, because the employee signs rather than transacts.
 *  - no signature: return the EIP-712 payload for them to sign
 *  - with signature: relay the pledge and open the loan
 */
export async function POST(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

  const body = await req.json();
  const shares = Number(body.shares);
  const amount = String(body.amount ?? "0");
  const termDays = Number(body.termDays ?? 30);

  if (!Number.isFinite(shares) || shares <= 0) {
    return NextResponse.json({ error: "Choose how many shares to pledge." }, { status: 400 });
  }

  const capacity = await readBorrowing(auth.wallet);
  if (shares > capacity.pledgeable) {
    return NextResponse.json({ error: "You do not have that many claimed shares." }, { status: 400 });
  }

  let amountUsdc: bigint;
  try {
    amountUsdc = parseUnits(amount, 6);
  } catch {
    return NextResponse.json({ error: "That is not a valid amount." }, { status: 400 });
  }
  if (amountUsdc <= 0n) return NextResponse.json({ error: "Choose an amount to borrow." }, { status: 400 });

  const pledge = await buildPledge(auth.wallet, shares, amountUsdc, termDays);

  if (!body.signature) {
    // Serialised because JSON cannot carry bigints, and the client only needs to sign it.
    return NextResponse.json({ pledge: JSON.parse(JSON.stringify(pledge, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
  }

  try {
    const { holdTx, borrowTx } = await relayBorrow(auth.wallet, pledge, body.signature as Hex);
    return NextResponse.json({ holdTx, borrowTx, borrowing: await readBorrowing(auth.wallet) });
  } catch (err) {
    console.error("Borrow failed", err);
    const message = err instanceof Error ? err.message.split("\n")[0] : "The loan did not go through.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
