import { NextResponse } from "next/server";
import { getMarketScope } from "@/lib/market-scope";
import { marketRevision } from "@/lib/market-revision";

// The open pages poll this between imports. It must resolve the scope the
// same way the pages do, or a pinned market would poll another market's
// revision forever.
export const dynamic = "force-dynamic";

export async function GET() {
  const scope = await getMarketScope();
  const revision = marketRevision(scope);
  return NextResponse.json({ revision }, { headers: { "Cache-Control": "no-store" } });
}
