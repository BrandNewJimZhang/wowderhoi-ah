import { NextResponse } from "next/server";
import { getMarketSignals } from "@/lib/market-signals";

export async function GET() {
  const bundle = await getMarketSignals();
  return NextResponse.json(bundle);
}
