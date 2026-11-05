// Deterministic Core.evaluate inputs for tests ONLY. Never imported by a
// page or route: production input is built from the imported scan.
import type { CoreInput } from "@/lib/core/types";

const CORE_NOW = 1_700_000_000;

export function commodityInput(overrides?: {
  ageHours?: number;
  phase?: CoreInput["phaseOverride"];
  items?: CoreInput["market"]["items"];
  budget?: number;
  bagSlots?: number;
}): CoreInput {
  const ageHours = overrides?.ageHours ?? 30;
  return {
    now: CORE_NOW,
    phaseOverride: overrides?.phase,
    market: {
      firstScanAt: CORE_NOW - ageHours * 3600,
      items: overrides?.items ?? {
        2589: {
          name: "亚麻布",
          itemClass: "Trade Goods",
          marketType: "commodity",
          vendorP: 10,
          minPrice: 700,
          sellP: 1000,
          quantity: 1000,
          numAuctions: 10,
          sellers: 4,
          tiers: [
            { p: 700, q: 20 },
            { p: 800, q: 100 },
            { p: 1000, q: 500 }
          ],
          history: { samples: 8 },
          inferredSoldLow: 50,
          inferredSoldHigh: 50,
          elapsedHours: 0.25
        }
      }
    },
    capital: { cash: 100000, budget: overrides?.budget ?? 100000 },
    capacity: { bagSlots: overrides?.bagSlots ?? 20, stackSize: 20 }
  };
}
