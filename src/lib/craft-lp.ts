// Production network: maximise profit subject to profession capacity,
// material supply and budget. The dual variables are shadow prices — what
// one more craft slot or one more unit of a material is worth today.
//
// The solver is a small dense simplex. Real recipe counts are in the
// thousands, so the candidate set is trimmed to the most profitable
// crafts first; if the simplex fails (degenerate or unbounded), the caller
// gets a labelled greedy allocation instead of a silent wrong answer.
export type LpRecipe = {
  id: number;
  name: string;
  profession: string;
  category?: string;
  materials: Array<{ itemId: number; qty: number }>;
  products: Array<{ itemId: number; qty: number }>;
};

export type ProductionOptions = {
  prices: Map<number, number>; // sell front per item, copper
  vendorPrices?: Map<number, number>;
  capacity: Record<string, number>; // profession -> daily craft slots
  materialSupply?: Map<number, number>;
  budget?: number;
  feeRate: number;
  maxCandidates?: number;
  preferGreedy?: boolean;
};

export type ProductionRow = {
  recipe: LpRecipe;
  unitCost: number;
  unitRevenue: number;
  unitProfit: number;
  marginPercent: number;
  volume: number;
  totalProfit: number;
  missing: string[];
};

export type ProductionSolution = {
  rows: ProductionRow[];
  totalProfit: number;
  shadowPrices: Record<string, number>;
  method: "lp" | "greedy";
  candidates: number;
  excluded: number;
};

type Constraint = { name: string; coefficients: number[]; limit: number };

const EPSILON = 1e-9;

// max c^T x s.t. A x <= b, x >= 0. Returns primal values and the dual
// price of every constraint. Bland's rule keeps the pivot sequence from
// cycling on degenerate tableaux.
export function simplex(A: number[][], b: number[], c: number[]): { x: number[]; duals: number[] } | null {
  const m = A.length;
  const n = c.length;
  if (m === 0) return { x: new Array(n).fill(0), duals: [] };
  const width = n + m + 1;
  const tableau: number[][] = [];
  for (let row = 0; row < m; row += 1) {
    const values = new Array(width).fill(0);
    for (let column = 0; column < n; column += 1) values[column] = A[row][column] ?? 0;
    values[n + row] = 1;
    values[width - 1] = b[row];
    if (values[width - 1] < 0) return null; // infeasible with b >= 0 only
    tableau.push(values);
  }
  const objective = new Array(width).fill(0);
  for (let column = 0; column < n; column += 1) objective[column] = -c[column];
  tableau.push(objective);
  const basis = Array.from({ length: m }, (_, row) => n + row);

  for (let iteration = 0; iteration < 10000; iteration += 1) {
    let entering = -1;
    for (let column = 0; column < n + m; column += 1) {
      if (tableau[m][column] < -EPSILON) { entering = column; break; }
    }
    if (entering === -1) break;
    let leaving = -1;
    let bestRatio = Infinity;
    for (let row = 0; row < m; row += 1) {
      const coefficient = tableau[row][entering];
      if (coefficient > EPSILON) {
        const ratio = tableau[row][width - 1] / coefficient;
        if (ratio < bestRatio - EPSILON || (Math.abs(ratio - bestRatio) <= EPSILON && (leaving === -1 || row < leaving))) {
          bestRatio = ratio;
          leaving = row;
        }
      }
    }
    if (leaving === -1) return null; // unbounded
    const pivot = tableau[leaving][entering];
    for (let column = 0; column < width; column += 1) tableau[leaving][column] /= pivot;
    for (let row = 0; row <= m; row += 1) {
      if (row === leaving) continue;
      const factor = tableau[row][entering];
      if (Math.abs(factor) <= EPSILON) continue;
      for (let column = 0; column < width; column += 1) {
        tableau[row][column] -= factor * tableau[leaving][column];
      }
    }
    basis[leaving] = entering;
  }

  const x = new Array(n).fill(0);
  for (let row = 0; row < m; row += 1) {
    if (basis[row] < n) x[basis[row]] = tableau[row][width - 1];
  }
  const duals = new Array(m).fill(0);
  for (let row = 0; row < m; row += 1) duals[row] = tableau[m][n + row];
  return { x, duals };
}

function unitEconomics(recipe: LpRecipe, options: ProductionOptions) {
  const missing: string[] = [];
  let cost = 0;
  for (const material of recipe.materials) {
    const price = options.prices.get(material.itemId) ?? options.vendorPrices?.get(material.itemId);
    if (price === undefined) missing.push(String(material.itemId));
    else cost += material.qty * price;
  }
  let revenue = 0;
  for (const product of recipe.products) {
    const price = options.prices.get(product.itemId);
    if (price === undefined) missing.push(String(product.itemId));
    else revenue += product.qty * price;
  }
  if (missing.length > 0) return { cost, revenue, profit: 0, missing };
  const netRevenue = revenue * (1 - options.feeRate);
  return { cost, revenue: netRevenue, profit: netRevenue - cost, missing };
}

function greedy(rows: ProductionRow[], constraints: Constraint[], remaining: number[]): number[] {
  const volumes = new Array(rows.length).fill(0);
  const order = rows
    .map((row, index) => ({ index, profit: row.unitProfit }))
    .sort((left, right) => right.profit - left.profit);
  for (const { index } of order) {
    let volume = Infinity;
    constraints.forEach((constraint, constraintIndex) => {
      const coefficient = constraint.coefficients[index];
      if (coefficient > 0) volume = Math.min(volume, remaining[constraintIndex] / coefficient);
    });
    if (!Number.isFinite(volume)) volume = 0;
    volume = Math.max(0, volume);
    volumes[index] = volume;
    constraints.forEach((constraint, constraintIndex) => {
      remaining[constraintIndex] -= constraint.coefficients[index] * volume;
    });
  }
  return volumes;
}

export function solveProduction(recipes: LpRecipe[], options: ProductionOptions): ProductionSolution {
  const evaluated = recipes.map((recipe) => {
    const economics = unitEconomics(recipe, options);
    const marginPercent = economics.cost > 0 ? (economics.profit / economics.cost) * 100 : economics.profit > 0 ? Infinity : 0;
    return {
      recipe,
      unitCost: economics.cost,
      unitRevenue: economics.revenue,
      unitProfit: economics.profit,
      marginPercent,
      volume: 0,
      totalProfit: 0,
      missing: economics.missing
    } satisfies ProductionRow;
  });
  const excluded = evaluated.filter((row) => row.missing.length > 0).length;
  const candidates = evaluated
    .filter((row) => row.missing.length === 0 && row.unitProfit > 0)
    .sort((left, right) => right.unitProfit - left.unitProfit)
    .slice(0, options.maxCandidates ?? 120);

  if (candidates.length === 0) {
    return { rows: [], totalProfit: 0, shadowPrices: {}, method: "lp", candidates: 0, excluded };
  }

  const constraints: Constraint[] = [];
  const professions = Array.from(new Set(candidates.map((row) => row.recipe.profession))).sort();
  for (const profession of professions) {
    const limit = options.capacity[profession];
    if (limit === undefined || limit <= 0) continue;
    constraints.push({
      name: `profession:${profession}`,
      coefficients: candidates.map((row) => (row.recipe.profession === profession ? 1 : 0)),
      limit
    });
  }
  if (options.materialSupply) {
    const materialIds = Array.from(new Set(candidates.flatMap((row) => row.recipe.materials.map((material) => material.itemId)))).sort((left, right) => left - right);
    for (const itemId of materialIds) {
      const limit = options.materialSupply.get(itemId);
      if (limit === undefined || limit <= 0) continue;
      constraints.push({
        name: `material:${itemId}`,
        coefficients: candidates.map((row) => row.recipe.materials.find((material) => material.itemId === itemId)?.qty ?? 0),
        limit
      });
    }
  }
  if (options.budget && options.budget > 0) {
    constraints.push({
      name: "budget",
      coefficients: candidates.map((row) => row.unitCost),
      limit: options.budget
    });
  }
  if (constraints.length === 0) {
    // Without any limit the LP is unbounded; a single shared slot cap is
    // the honest default rather than a silently infinite recommendation.
    constraints.push({ name: "profession:all", coefficients: candidates.map(() => 1), limit: 100 });
  }

  let volumes: number[] | null = null;
  let duals: number[] | null = null;
  let method: "lp" | "greedy" = "lp";
  if (!options.preferGreedy) {
    const solved = simplex(
      constraints.map((constraint) => constraint.coefficients),
      constraints.map((constraint) => constraint.limit),
      candidates.map((row) => row.unitProfit)
    );
    if (solved) {
      volumes = solved.x;
      duals = solved.duals;
    }
  }
  if (!volumes) {
    method = "greedy";
    const remaining = constraints.map((constraint) => constraint.limit);
    volumes = greedy(candidates, constraints, remaining);
    duals = constraints.map(() => 0);
  }

  const shadowPrices: Record<string, number> = {};
  constraints.forEach((constraint, index) => {
    shadowPrices[constraint.name] = Math.round((duals?.[index] ?? 0) * 100) / 100;
  });

  let totalProfit = 0;
  candidates.forEach((row, index) => {
    // Craft counts are integers; the LP relaxation is rounded down and the
    // reported profit is recomputed from the integer plan.
    const volume = Math.max(0, Math.floor((volumes?.[index] ?? 0) + EPSILON));
    row.volume = volume;
    row.totalProfit = volume * row.unitProfit;
    totalProfit += row.totalProfit;
  });
  const rows = candidates.filter((row) => row.volume > 0).sort((left, right) => right.totalProfit - left.totalProfit);
  return { rows, totalProfit, shadowPrices, method, candidates: candidates.length, excluded };
}
