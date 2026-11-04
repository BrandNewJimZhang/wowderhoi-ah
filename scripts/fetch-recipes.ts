// Fetches the complete Forever recipe catalogue from the public
// wuxianwow MCP endpoint and writes data/recipes.forever.json. The list
// endpoint gives names and reagent strings; each detail call adds the
// authoritative item IDs the production solver needs.
//
// One-off data refresh: `npm run recipes:fetch`. The committed dataset is
// the source of truth for `npm run recipes:import`; nothing at runtime
// calls the network.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://wuxianwow.com/mcp";
const OUTPUT = fileURLToPath(new URL("../data/recipes.forever.json", import.meta.url));
const PAGE_SIZE = 100;
const CONCURRENCY = 4;

let nextId = 1;

type McpRecipeSummary = {
  id: string;
  title: string;
  profession: string;
  category: string;
  new_in_160: boolean;
  effect: string;
  reagents: string;
};

type RecipeDetail = {
  id: number;
  name: string;
  profession: string;
  category: string;
  expansion: "forever" | "classic";
  effect: string;
  minRank: number | null;
  skillUpRange: [number, number] | null;
  materials: Array<{ itemId: number; name: string; qty: number }>;
  products: Array<{ itemId: number; name: string; qty: number; quality?: number; ilvl?: number }>;
};

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } })
  });
  if (!response.ok) throw new Error(`MCP ${name} failed: HTTP ${response.status}`);
  const text = await response.text();
  const payload = text.includes("data:")
    ? JSON.parse(text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("\n"))
    : JSON.parse(text);
  const content = payload?.result?.content?.[0]?.text;
  if (typeof content !== "string") throw new Error(`MCP ${name} returned no content: ${text.slice(0, 200)}`);
  return JSON.parse(content);
}

async function withRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt * attempt));
    }
  }
  throw new Error(`${label} failed after retries: ${String(lastError)}`);
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseDetail(id: number, detail: Record<string, unknown>, summary: McpRecipeSummary): RecipeDetail {
  const metadata = (detail.metadata ?? {}) as Record<string, unknown>;
  const reagents = Array.isArray(metadata.reagents) ? metadata.reagents as Array<Record<string, unknown>> : [];
  const products = Array.isArray(metadata.products) ? metadata.products as Array<Record<string, unknown>> : [];
  const skillRange = Array.isArray(metadata.skill_up_range) ? metadata.skill_up_range as number[] : null;
  return {
    id,
    name: summary.title,
    profession: summary.profession,
    category: summary.category,
    expansion: summary.new_in_160 ? "forever" : "classic",
    effect: summary.effect,
    minRank: typeof metadata.min_rank === "number" ? metadata.min_rank : null,
    skillUpRange: skillRange && skillRange.length === 2 ? [skillRange[0], skillRange[1]] : null,
    materials: reagents
      .filter((reagent) => reagent.hidden !== true && typeof reagent.item_id === "number")
      .map((reagent) => ({ itemId: reagent.item_id as number, name: String(reagent.name), qty: Number(reagent.count ?? 1) })),
    products: products
      .filter((product) => product.hidden !== true && typeof product.item_id === "number")
      .map((product) => ({
        itemId: product.item_id as number,
        name: String(product.name),
        qty: Number(product.count ?? 1),
        quality: typeof product.quality === "number" ? product.quality : undefined,
        ilvl: typeof product.ilvl === "number" ? product.ilvl : undefined
      }))
  };
}

async function main() {
  const summaries: McpRecipeSummary[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await withRetry(`recipes page ${offset}`, () =>
      callTool("recipes", { limit: PAGE_SIZE, offset })
    ) as { total: number; results: McpRecipeSummary[]; has_more: boolean };
    summaries.push(...page.results);
    process.stdout.write(`\rlisted ${summaries.length}/${page.total}`);
    if (!page.has_more) break;
  }
  process.stdout.write("\n");

  let done = 0;
  const recipes = await mapLimit(summaries, CONCURRENCY, async (summary) => {
    const id = Number(summary.id.replace("recipe:", ""));
    const detail = await withRetry(`recipe ${id}`, () => callTool("fetch", { id: summary.id })) as Record<string, unknown>;
    done += 1;
    if (done % 50 === 0) process.stdout.write(`\rdetails ${done}/${summaries.length}`);
    return parseDetail(id, detail, summary);
  });
  process.stdout.write("\n");

  const missingIds = recipes.filter((recipe) => recipe.products.length === 0 || recipe.materials.length === 0);
  if (recipes.length !== summaries.length || recipes.length === 0) {
    throw new Error(`Recipe count mismatch: listed ${summaries.length}, parsed ${recipes.length}`);
  }
  mkdirSync(fileURLToPath(new URL("../data", import.meta.url)), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify({
    source: "https://wuxianwow.com (无限图鉴)",
    fetchedAt: new Date().toISOString(),
    total: recipes.length,
    recipes
  }, null, 0));
  console.log(`Wrote ${recipes.length} recipes to ${OUTPUT}`);
  console.log(`Recipes with a missing product or material: ${missingIds.length}`);
}

void main();
