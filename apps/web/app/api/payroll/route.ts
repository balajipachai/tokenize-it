import { NextResponse } from "next/server";
import type { Address } from "viem";
import { approveRun, discardRun, draftRun, readEarnings, readPayroll, submitRun } from "@/lib/payroll";
import { requireGrantAdmin } from "@/lib/payrollAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * NOTE ON AUTHORITY, because this route is unlike every other write in this console.
 *
 * Everything else here is signed by HR's own MetaMask, so the browser proves who is acting.
 * Payroll cannot work that way: the treasury is a Privy wallet whose quorum signs API
 * requests, not Hedera transactions, so the officer keys live on the server. That makes this
 * route the approval authority rather than a relay of one — which is exactly why every
 * request must come from a signed-in grant admin (see lib/payrollAuth.ts). Without that
 * check, anyone who found the URL could draft, approve and submit a run.
 *
 * What the check does NOT restore is the quorum's independence: one grant admin can still
 * approve as every officer, because every officer key sits in this one process. A real
 * deployment splits the keys, each officer approving from their own client, so no single
 * process can assemble a quorum. Nothing in the contract or the Privy configuration changes.
 */
export async function GET(req: Request) {
  const auth = await requireGrantAdmin(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error, signIn: true }, { status: auth.status });
  try {
    const url = new URL(req.url);
    const employees = (url.searchParams.get("employees") ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean) as Address[];
    const [state, earnings] = await Promise.all([readPayroll(), readEarnings(employees)]);
    return NextResponse.json({ ...state, earnings, signedInAs: auth.address });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Payroll is not configured." }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const auth = await requireGrantAdmin(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error, signIn: true }, { status: auth.status });
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "draft":
        return NextResponse.json({ pending: draftRun(body.recipients, body.amounts) });
      case "approve":
        return NextResponse.json({ pending: approveRun(Number(body.officer)) });
      case "discard":
        discardRun();
        return NextResponse.json({ pending: null });
      case "submit":
        return NextResponse.json(await submitRun());
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : "That did not work.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
