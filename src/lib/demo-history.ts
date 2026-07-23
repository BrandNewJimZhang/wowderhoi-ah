// Synthetic market histories for unit tests ONLY — never imported by
// production code paths (repositories, pages, seed). The terminal shows
// real scanned data or an explicit empty state.
import type { MarketHistory } from "@/lib/market-data";

export const demoItems = [
  { itemId: 2770, name: "铜矿石", quality: "common", category: "矿石", subCategory: "采矿" },
  { itemId: 2771, name: "锡矿石", quality: "common", category: "矿石", subCategory: "采矿" },
  { itemId: 2772, name: "铁矿石", quality: "common", category: "矿石", subCategory: "采矿" },
  { itemId: 3858, name: "秘银矿石", quality: "common", category: "矿石", subCategory: "采矿" },
  { itemId: 10620, name: "瑟银矿石", quality: "common", category: "矿石", subCategory: "采矿" },
  { itemId: 2589, name: "亚麻布", quality: "common", category: "布料", subCategory: "裁缝" },
  { itemId: 2592, name: "毛料", quality: "common", category: "布料", subCategory: "裁缝" },
  { itemId: 4306, name: "丝绸", quality: "common", category: "布料", subCategory: "裁缝" },
  { itemId: 4338, name: "魔纹布", quality: "common", category: "布料", subCategory: "裁缝" },
  { itemId: 14047, name: "符文布", quality: "common", category: "布料", subCategory: "裁缝" },
  { itemId: 13468, name: "黑莲花", quality: "rare", category: "草药", subCategory: "炼金" },
  { itemId: 12363, name: "奥术水晶", quality: "rare", category: "宝石", subCategory: "采矿" },
  { itemId: 12360, name: "奥金锭", quality: "rare", category: "金属", subCategory: "炼金" },
  { itemId: 13467, name: "冰盖草", quality: "common", category: "草药", subCategory: "炼金" },
  { itemId: 13466, name: "瘟疫花", quality: "common", category: "草药", subCategory: "炼金" }
];

export function generateDemoHistory(days = 21): MarketHistory[] {
  const now = new Date();
  return demoItems.map((item, itemIndex) => {
    const base = 1_500 + itemIndex * 1_850 + (item.quality === "rare" ? 120_000 : 0);
    const dailySummaries = Array.from({ length: days }, (_, offset) => {
      const age = days - offset - 1;
      const date = new Date(now);
      date.setDate(now.getDate() - age);
      date.setHours(0, 0, 0, 0);
      const drift = 1 + Math.sin((offset + itemIndex) / 2.8) * 0.12 + offset * 0.006;
      const shock = item.name === "奥术水晶" && offset > days - 5 ? 1.18 : 1;
      const closePrice = Math.round(base * drift * shock);
      const openPrice = Math.round(closePrice * (0.96 + ((offset + itemIndex) % 6) * 0.015));
      const highPrice = Math.max(openPrice, Math.round(closePrice * 1.05));
      const lowPrice = Math.min(openPrice, Math.round(closePrice * 0.93));
      const volume = Math.round(280 + itemIndex * 30 + Math.cos(offset / 1.7) * 80 + (shock > 1 ? 420 : 0));
      return { date, openPrice, closePrice, highPrice, lowPrice, volume };
    });
    const latest = dailySummaries[dailySummaries.length - 1];
    const snapshots = Array.from({ length: 16 }, (_, offset) => {
      const timestamp = new Date(now.getTime() - (15 - offset) * 30 * 60 * 1000);
      const pulse = 1 + Math.sin(offset / 2 + itemIndex) * 0.025;
      return {
        timestamp,
        server: "Anniversary",
        faction: "Alliance",
        minPrice: Math.round(latest.closePrice * 0.97 * pulse),
        marketPrice: Math.round(latest.closePrice * pulse),
        quantity: Math.max(12, Math.round(latest.volume / 2 + Math.sin(offset) * 35)),
        numAuctions: Math.max(5, Math.round(latest.volume / 18 + Math.cos(offset) * 9))
      };
    });
    return { ...item, vendorPrice: 0, snapshots, dailySummaries };
  });
}
