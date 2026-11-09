// Maps the client catalogue's numeric item class and subclass onto the
// localised labels the addon reads from GetItemInfo. The catalogue is the
// only source of item facts, so this table is the single place where a
// numeric class becomes the Chinese category the demand priors and the
// market filters already use. A label this table invents and the demand
// bands do not know would silently drop the item's prior, so the coverage
// test walks the committed catalogue against demand-bands.json.

type CatalogClassInput = {
  cls: number;
  sub: number;
  armorType?: string | null;
  weaponType?: string | null;
};

type ItemTaxonomy = { category: string; subCategory: string };

const ITEM_CLASSES: Record<number, string> = {
  0: "消耗品",
  1: "容器",
  2: "武器",
  3: "宝石",
  4: "护甲",
  5: "材料",
  6: "弹药",
  7: "商品",
  8: "物品强化",
  9: "配方",
  11: "箭袋",
  12: "任务",
  13: "钥匙",
  15: "其它"
};

const CONSUMABLE_SUBCLASSES: Record<number, string> = {
  0: "炸药",
  1: "药水",
  2: "药剂",
  3: "合剂",
  4: "卷轴",
  5: "食物和饮料",
  6: "物品强化",
  7: "绷带",
  8: "其它",
  14: "其它",
  15: "其它"
};

const CONTAINER_SUBCLASSES: Record<number, string> = {
  0: "容器",
  1: "灵魂袋",
  2: "草药袋",
  3: "附魔袋",
  6: "采矿包",
  7: "剥皮包",
  11: "材料包"
};

const PROJECTILE_SUBCLASSES: Record<number, string> = {
  2: "箭",
  3: "子弹"
};

const TRADE_GOOD_SUBCLASSES: Record<number, string> = {
  0: "其它",
  1: "零件",
  2: "炸药",
  5: "布",
  6: "皮革",
  7: "金属和矿石",
  8: "肉类",
  9: "草药",
  10: "元素",
  11: "附魔",
  12: "其它"
};

// Recipe subclasses are professions. 0 is books and teaching tomes without
// a trade skill; 9 is fishing, which has no production network.
const RECIPE_SUBCLASSES: Record<number, string> = {
  0: "其它",
  1: "制皮",
  2: "裁缝",
  3: "工程学",
  4: "锻造",
  5: "烹饪",
  6: "炼金术",
  7: "急救",
  8: "附魔",
  9: "钓鱼"
};

const QUIVER_SUBCLASSES: Record<number, string> = {
  2: "箭袋",
  3: "弹药袋"
};

const MISC_SUBCLASSES: Record<number, string> = {
  0: "垃圾",
  1: "材料",
  2: "宠物",
  3: "节日",
  4: "其它",
  5: "其它"
};

function pick(table: Record<number, string>, sub: number): string {
  return table[sub] ?? "其它";
}

export function itemTaxonomy(input: CatalogClassInput): ItemTaxonomy {
  const category = ITEM_CLASSES[input.cls] ?? "其它";
  switch (input.cls) {
    case 0:
      return { category, subCategory: pick(CONSUMABLE_SUBCLASSES, input.sub) };
    case 1:
      return { category, subCategory: pick(CONTAINER_SUBCLASSES, input.sub) };
    case 2:
      // The catalogue localises the weapon type on the item; the numeric
      // subclass only distinguishes one-hand, two-hand and ranged groups.
      return { category, subCategory: input.weaponType || "其它" };
    case 3:
      return { category, subCategory: "宝石" };
    case 4:
      return { category, subCategory: input.armorType || "其它" };
    case 5:
      return { category, subCategory: "材料" };
    case 6:
      return { category, subCategory: pick(PROJECTILE_SUBCLASSES, input.sub) };
    case 7:
      return { category, subCategory: pick(TRADE_GOOD_SUBCLASSES, input.sub) };
    case 8:
      return { category, subCategory: "物品强化" };
    case 9:
      return { category, subCategory: pick(RECIPE_SUBCLASSES, input.sub) };
    case 11:
      return { category, subCategory: pick(QUIVER_SUBCLASSES, input.sub) };
    case 12:
      return { category, subCategory: "任务" };
    case 13:
      return { category, subCategory: "钥匙" };
    case 15:
      return { category, subCategory: pick(MISC_SUBCLASSES, input.sub) };
    default:
      return { category, subCategory: "其它" };
  }
}
