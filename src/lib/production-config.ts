// Player-configured production capacity. These are attention / craft-slot
// budgets per in-game day, not client facts: the client exposes recipes,
// not how many crafts a player intends to perform. Tune them per character.
import { AH_FEE_RATE, DEFAULT_BUDGET_COPPER } from "@/lib/market-rules";

export const productionCapacity: Record<string, number> = {
  裁缝: 40,
  制皮: 40,
  锻造: 30,
  工程学: 30,
  炼金术: 60,
  附魔: 60,
  烹饪: 100,
  急救: 100,
  钓鱼: 20,
  采矿: 20,
  草药学: 20,
  剥皮: 20,
  毒药: 10,
  理解: 10
};

export const productionDefaults = {
  feeRate: AH_FEE_RATE,
  budgetCopper: DEFAULT_BUDGET_COPPER,
  maxCandidates: 120
} as const;
