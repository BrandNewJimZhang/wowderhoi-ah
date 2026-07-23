import { NextResponse } from "next/server";
import { buildMarketSignal } from "@/lib/analytics";
import { getMarketUniverse } from "@/lib/repositories";

export async function GET() {
  const universe = await getMarketUniverse();
  const now = new Date();
  const signals = universe.filter((item) => item.snapshots.length > 0).map((item) => buildMarketSignal(item, now));
  return NextResponse.json({ signals });
}
