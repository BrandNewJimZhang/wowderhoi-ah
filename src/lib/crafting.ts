// Craft profit engine plus the curated TBC phase-2 recipe table.
// Quantities are curated seed data (verify in-game before trusting large
// positions); itemIds are authoritative, names are display labels.

export type CraftRecipe = {
  name: string;
  productItemId: number;
  productQuantity: number;
  profession: string;
  materials: Array<{ itemId: number; name: string; quantity: number; vendorPriceCopper?: number }>;
};

export type CraftProfitRow = {
  recipe: CraftRecipe;
  status: "ok" | "missing";
  cost: number;
  revenue: number;
  profit: number;
  marginPercent: number;
  missing: string[];
};

const AH_CUT = 0.05; // neutral/faction AH cut on successful sales

export const craftRecipes: CraftRecipe[] = [
  // Classic-era staples — the leveling economy trades these, not TBC mats.
  {
    name: "铜锭",
    productItemId: 2840,
    productQuantity: 1,
    profession: "采矿",
    materials: [{ itemId: 2770, name: "铜矿石", quantity: 1 }]
  },
  {
    name: "青铜锭",
    productItemId: 2841,
    productQuantity: 2,
    profession: "采矿(熔合)",
    materials: [
      { itemId: 2840, name: "铜锭", quantity: 1 },
      { itemId: 3576, name: "锡锭", quantity: 1 }
    ]
  },
  {
    name: "毛料卷",
    productItemId: 2997,
    productQuantity: 1,
    profession: "裁缝",
    materials: [{ itemId: 2592, name: "毛料", quantity: 3 }]
  },
  {
    name: "丝绸卷",
    productItemId: 4305,
    productQuantity: 1,
    profession: "裁缝",
    materials: [{ itemId: 4306, name: "丝绸", quantity: 4 }]
  },
  {
    name: "魔铁锭",
    productItemId: 23445,
    productQuantity: 1,
    profession: "采矿",
    materials: [{ itemId: 23424, name: "魔铁矿石", quantity: 2 }]
  },
  {
    name: "精金锭",
    productItemId: 23446,
    productQuantity: 1,
    profession: "采矿",
    materials: [{ itemId: 23425, name: "精金矿石", quantity: 2 }]
  },
  {
    name: "灵纹布卷",
    productItemId: 21840,
    productQuantity: 1,
    profession: "裁缝",
    materials: [{ itemId: 21877, name: "灵纹布", quantity: 5 }]
  },
  {
    name: "恶魔皮",
    productItemId: 21887,
    productQuantity: 1,
    profession: "制皮",
    materials: [{ itemId: 25649, name: "恶魔皮碎片", quantity: 5 }]
  },
  {
    name: "原始法力精华",
    productItemId: 23571,
    productQuantity: 1,
    profession: "炼金(转化)",
    materials: [
      { itemId: 21884, name: "火焰之髓", quantity: 1 },
      { itemId: 21885, name: "水之髓", quantity: 1 },
      { itemId: 22452, name: "土之髓", quantity: 1 },
      { itemId: 22451, name: "空气之髓", quantity: 1 },
      { itemId: 22457, name: "法力之髓", quantity: 1 }
    ]
  },
  {
    name: "特效法力药水",
    productItemId: 22832,
    productQuantity: 1,
    profession: "炼金",
    materials: [
      { itemId: 22786, name: "梦露花", quantity: 2 },
      { itemId: 22785, name: "梦叶草", quantity: 1 },
      { itemId: 18256, name: "注魔之瓶", quantity: 1, vendorPriceCopper: 4000 }
    ]
  },
  {
    name: "特效治疗药水",
    productItemId: 22829,
    productQuantity: 1,
    profession: "炼金",
    materials: [
      { itemId: 22791, name: "虚空花", quantity: 2 },
      { itemId: 22785, name: "梦叶草", quantity: 1 },
      { itemId: 18256, name: "注魔之瓶", quantity: 1, vendorPriceCopper: 4000 }
    ]
  },
  {
    name: "卓越巫师油",
    productItemId: 22522,
    productQuantity: 5,
    profession: "炼金",
    materials: [
      { itemId: 22791, name: "虚空花", quantity: 3 },
      { itemId: 18256, name: "注魔之瓶", quantity: 1, vendorPriceCopper: 4000 }
    ]
  },
  {
    name: "强化合剂",
    productItemId: 22851,
    productQuantity: 1,
    profession: "炼金",
    materials: [
      { itemId: 22790, name: "古老地衣", quantity: 7 },
      { itemId: 22785, name: "梦叶草", quantity: 3 },
      { itemId: 22794, name: "魔莲花", quantity: 1 },
      { itemId: 18256, name: "注魔之瓶", quantity: 1, vendorPriceCopper: 4000 }
    ]
  }
];

export function computeCraftProfits(recipes: CraftRecipe[], priceByItemId: Map<number, number>): CraftProfitRow[] {
  const rows = recipes.map<CraftProfitRow>((recipe) => {
    const missing: string[] = [];
    let cost = 0;
    for (const material of recipe.materials) {
      const price = priceByItemId.get(material.itemId) ?? material.vendorPriceCopper;
      if (price === undefined) {
        missing.push(material.name);
      } else {
        cost += material.quantity * price;
      }
    }
    const productPrice = priceByItemId.get(recipe.productItemId);
    if (productPrice === undefined) missing.push(recipe.name);
    if (missing.length > 0) {
      return { recipe, status: "missing", cost: 0, revenue: 0, profit: 0, marginPercent: 0, missing };
    }
    const revenue = Math.round(recipe.productQuantity * productPrice! * (1 - AH_CUT));
    const profit = revenue - cost;
    return {
      recipe,
      status: "ok",
      cost,
      revenue,
      profit,
      marginPercent: cost === 0 ? 0 : (profit / cost) * 100,
      missing: []
    };
  });
  return rows.sort((left, right) => {
    if (left.status !== right.status) return left.status === "ok" ? -1 : 1;
    return right.profit - left.profit;
  });
}
