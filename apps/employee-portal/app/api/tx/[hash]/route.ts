import { NextResponse } from "next/server";
import { requireWallet } from "@/lib/privyServer";
import { txStatus } from "@/lib/contracts";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const auth = await requireWallet(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

  const { hash } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return NextResponse.json({ error: "Not a transaction hash." }, { status: 400 });
  }
  return NextResponse.json({ status: await txStatus(hash as `0x${string}`) });
}
