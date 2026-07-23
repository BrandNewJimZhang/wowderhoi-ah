"use server";

// Single mutation surface for watchlist and alert rules. All writes
// revalidate the pages that render them.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { alertMetricKeys, type AlertMetricKey } from "@/lib/alerts";

export async function toggleWatchlist(itemId: number) {
  const existing = await prisma.watchlist.findUnique({ where: { itemId } });
  if (existing) {
    await prisma.watchlist.delete({ where: { itemId } });
  } else {
    await prisma.watchlist.create({ data: { itemId } });
  }
  revalidatePath("/");
  revalidatePath(`/items/${itemId}`);
}

export async function createAlertRule(itemId: number, metric: string, operator: string, threshold: number) {
  if (!alertMetricKeys.includes(metric as AlertMetricKey)) {
    throw new Error(`Unknown alert metric "${metric}"`);
  }
  if (operator !== "gt" && operator !== "lt") {
    throw new Error(`Unknown alert operator "${operator}"`);
  }
  if (!Number.isFinite(threshold)) {
    throw new Error(`Alert threshold must be a finite number, got ${threshold}`);
  }
  await prisma.alertRule.create({ data: { itemId, metric, operator, threshold } });
  revalidatePath("/");
  revalidatePath(`/items/${itemId}`);
}

export async function deleteAlertRule(id: string) {
  const rule = await prisma.alertRule.delete({ where: { id } });
  revalidatePath("/");
  revalidatePath(`/items/${rule.itemId}`);
}


