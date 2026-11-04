import { NextResponse } from "next/server";
import { buildMarketSignal } from "@/lib/analytics";
import { getMarketScope } from "@/lib/market-scope";
import { getItemDetail } from "@/lib/repositories";

export async function GET(_: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItemDetail(Number(itemId), await getMarketScope());
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const signal = item.snapshots.length > 0 ? buildMarketSignal(item, new Date()) : null;
  return NextResponse.json({ item, signal });
}
