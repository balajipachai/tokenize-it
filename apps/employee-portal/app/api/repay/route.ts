import { NextResponse } from "next/server";
import { parseUnits, type Hex } from "viem";
import { requireWallet } from "@/lib/privyServer";
import { buildRepayPermit, readBorrowing, relayRepay } from "@/lib/lending";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

  const body = await req.json();
  const loanId = Number(body.loanId);
  const borrowing = await readBorrowing(auth.wallet);
  const loan = borrowing.loans.find((l) => l.loanId === loanId && l.status === 1);
  if (!loan) return NextResponse.json({ error: "No open loan with that id." }, { status: 400 });

  // Headroom: interest accrues per second, so approving the figure shown would fall short
  // by whatever the transaction takes to mine. The pool only ever pulls what is owed.
  const owed = parseUnits(loan.debt, 6);
  let value = owed + parseUnits("1", 6);
  let deadline: bigint | undefined;

  // On the signing pass both the value and the deadline must be the ones actually signed —
  // debt accrues between the two calls, so recomputing would invalidate the permit. Bound
  // them instead: enough to clear the debt, not so much that a stale payload over-approves.
  if (body.signature) {
    if (body.signed?.value === undefined || body.signed?.deadline === undefined) {
      return NextResponse.json({ error: "That signature is missing its terms. Try again." }, { status: 400 });
    }
    try {
      value = BigInt(body.signed.value);
      deadline = BigInt(body.signed.deadline);
    } catch {
      return NextResponse.json({ error: "That signature's terms are malformed." }, { status: 400 });
    }
    if (value < owed || value > owed + parseUnits("5", 6)) {
      return NextResponse.json({ error: "The amount owed has moved. Try the repayment again." }, { status: 409 });
    }
  }

  let permit;
  try {
    permit = await buildRepayPermit(auth.wallet, value, deadline);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not prepare that." }, { status: 400 });
  }

  if (!body.signature) {
    return NextResponse.json({
      permit: JSON.parse(JSON.stringify(permit, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      owed: loan.debt,
    });
  }

  try {
    const { permitTx, repayTx } = await relayRepay(auth.wallet, loanId, permit.message, body.signature as Hex);
    return NextResponse.json({ permitTx, repayTx, borrowing: await readBorrowing(auth.wallet) });
  } catch (err) {
    console.error("Repay failed", err);
    const message = err instanceof Error ? err.message.split("\n")[0] : "The repayment did not go through.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
