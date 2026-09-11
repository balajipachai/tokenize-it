import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves the repo's deployment record so the client does not hardcode addresses. */
export async function GET() {
  const file = path.resolve(process.cwd(), "../../deployments/hedera-testnet.json");
  if (!fs.existsSync(file)) {
    return NextResponse.json({ error: "No deployment record. Run 'npm run testnet:deploy-controller'." }, { status: 503 });
  }
  return NextResponse.json(JSON.parse(fs.readFileSync(file, "utf8")));
}
