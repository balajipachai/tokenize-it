import { NextResponse } from "next/server";
import { requireWallet } from "@/lib/privyServer";
import { readSalary, deliverSalary } from "@/lib/salary";

export const runtime = "nodejs";

/** What this employee has earned, collected, and holds. */
export async function GET(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json(await readSalary(auth.wallet));
}

/** Collects it. Paid for by the relayer, delivered only ever to the verified wallet. */
export async function POST(req: Request) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const salary = await readSalary(auth.wallet);
  if (!salary.configured) {
    return NextResponse.json({ error: "Payroll is not set up for this deployment." }, { status: 400 });
  }
  if (Number(salary.accrued) === 0) {
    return NextResponse.json({ error: "You have no salary waiting to be collected." }, { status: 400 });
  }

  try {
    const hash = await deliverSalary(auth.wallet);
    return NextResponse.json({ hash, amount: salary.accrued });
  } catch (err) {
    console.error("Salary delivery failed", err);
    return NextResponse.json({ error: "The payout did not go through. Try again shortly." }, { status: 502 });
  }
}
