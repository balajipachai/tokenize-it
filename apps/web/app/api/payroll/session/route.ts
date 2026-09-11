import { NextResponse } from "next/server";
import { clearedCookie, createSession, isSecure, requireGrantAdmin, sessionCookie } from "@/lib/payrollAuth";

export const runtime = "nodejs";

/** Who is signed in to payroll, if anyone. */
export async function GET(req: Request) {
  const auth = await requireGrantAdmin(req);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ address: auth.address });
}

/** Opens a session from a signed sign-in message. Grant admins only. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const result = await createSession(req, body);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  const res = NextResponse.json({ address: result.address });
  res.headers.set("Set-Cookie", sessionCookie(result.token, isSecure(req)));
  return res;
}

/** Signs out. */
export async function DELETE(req: Request) {
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearedCookie(isSecure(req)));
  return res;
}
