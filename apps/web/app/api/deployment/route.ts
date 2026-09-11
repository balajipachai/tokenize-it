import { NextResponse } from "next/server";
import { deploymentRecord } from "@/lib/deployment";

export const runtime = "nodejs";

/** Serves the repo's deployment record so the client does not hardcode addresses. */
export async function GET() {
  return NextResponse.json(deploymentRecord);
}
