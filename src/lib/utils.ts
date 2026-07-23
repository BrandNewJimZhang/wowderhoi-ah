import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatGold(copper: number) {
  const gold = copper / 10_000;
  return `${gold.toLocaleString("en-US", { maximumFractionDigits: 2 })}g`;
}

export function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}