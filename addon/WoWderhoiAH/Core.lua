-- Pure decision core. No WoW API, Lua 5.1 compatible, deterministic.
--
-- Every surface that recommends an action -- the in-game cockpit and the
-- desktop terminal -- runs this file. The desktop loads it through fengari
-- (src/lib/core/run-core.ts), so there is exactly one implementation of
-- the sell front, the ladder cost, the fill probability and the ranking.
--
-- Input and output are plain tables; the caller builds the input from the
-- latest scan, the retained series, the journal-derived positions and the
-- capital block. Nothing here reads globals or the clock.

local ADDON_NAME, WAH = ...
local Core = {}

Core.VERSION = 1

local function round(value) return math.floor(value + 0.5) end

local function copyList(list)
  local out = {}
  for index, value in ipairs(list or {}) do out[index] = value end
  return out
end

function Core.median(values)
  if not values or #values == 0 then return nil end
  local sorted = copyList(values)
  table.sort(sorted)
  -- Lower median, matching the terminal's median() so both sides round
  -- an even-length window to the same sample.
  return sorted[math.ceil(#sorted / 2)]
end

-- Tiers are { { p = unitPrice, q = quantity }, ... }. Sort defensively:
-- callers build them from an unordered replicate response.
function Core.sortedTiers(tiers)
  local sorted = {}
  for index, tier in ipairs(tiers or {}) do
    if tier.p and tier.p > 0 and tier.q and tier.q > 0 then
      sorted[#sorted + 1] = { p = tier.p, q = tier.q }
    end
  end
  table.sort(sorted, function(left, right)
    if left.p == right.p then return left.q < right.q end
    return left.p < right.p
  end)
  return sorted
end

function Core.totalQuantity(tiers)
  local total = 0
  for _, tier in ipairs(tiers) do total = total + tier.q end
  return total
end

function Core.weightedPercentile(tiers, fraction)
  local sorted = Core.sortedTiers(tiers)
  local total = Core.totalQuantity(sorted)
  if total <= 0 then return nil end
  local threshold = total * fraction
  local cumulative = 0
  for _, tier in ipairs(sorted) do
    cumulative = cumulative + tier.q
    if cumulative >= threshold then return tier.p end
  end
  return sorted[#sorted].p
end

-- Depth-aware sell front.
--
-- The upper book is noise: thin, stale listings nobody transacts against.
-- Listings above noiseMultiple times the quantity-weighted median are
-- excluded from the front (they stay in the book and in supply), then the
-- front is the cheapest price whose cumulative quantity reaches the depth
-- target. Item auctions are unique lots, so their depth is measured in
-- listings, not in units.
function Core.sellFront(tiers, opts)
  local rules = (opts and opts.rules) or (WAH.RULES and WAH.RULES.sellFront) or {}
  local sorted = Core.sortedTiers(tiers)
  local total = Core.totalQuantity(sorted)
  if total <= 0 then return nil end
  local noiseMultiple = rules.noiseMultiple or 3
  local median = Core.weightedPercentile(sorted, 0.5)
  local filtered = {}
  local filteredTotal = 0
  for _, tier in ipairs(sorted) do
    if not median or tier.p <= median * noiseMultiple then
      filtered[#filtered + 1] = tier
      filteredTotal = filteredTotal + tier.q
    end
  end
  if #filtered == 0 then return sorted[1].p end
  if opts and opts.byCount then
    local depth = math.min(opts.itemDepth or rules.itemDepth or 3, #filtered)
    return filtered[math.max(depth, 1)].p
  end
  local alpha = rules.alpha or 0.03
  local minDepth = opts and opts.minDepth or rules.minDepth or 3
  if opts and opts.early then minDepth = rules.minDepthEarly or 1 end
  local target = math.max(minDepth, math.ceil(filteredTotal * alpha))
  local cumulative = 0
  for _, tier in ipairs(filtered) do
    cumulative = cumulative + tier.q
    if cumulative >= target then return tier.p end
  end
  return filtered[#filtered].p
end

-- Cost of walking the offer ladder for `quantity` units. Commodity
-- purchases always take the cheapest units first, so the total is never
-- quantity times any single row's price.
function Core.ladderCost(tiers, quantity)
  local sorted = Core.sortedTiers(tiers)
  local remaining = quantity or 0
  local cost = 0
  local filled = 0
  for _, tier in ipairs(sorted) do
    if remaining <= 0 then break end
    local take = math.min(remaining, tier.q)
    cost = cost + take * tier.p
    filled = filled + take
    remaining = remaining - take
  end
  if filled == 0 then return 0, 0, nil end
  return cost, filled, cost / filled
end

-- Largest quantity the player can actually buy under a price cap, a
-- budget and a bag limit. Returns quantity, total cost, average price.
function Core.executableQty(tiers, priceCap, budget, bagCapacity)
  local sorted = Core.sortedTiers(tiers)
  local quantity, cost = 0, 0
  local remainingBudget = math.floor(budget or 0)
  for _, tier in ipairs(sorted) do
    if priceCap and priceCap > 0 and tier.p > priceCap then break end
    if remainingBudget <= 0 then break end
    if bagCapacity and quantity >= bagCapacity then break end
    local take = tier.q
    if bagCapacity then take = math.min(take, bagCapacity - quantity) end
    local affordable = math.floor(remainingBudget / tier.p)
    take = math.min(take, affordable)
    if take <= 0 then break end
    quantity = quantity + take
    cost = cost + take * tier.p
    remainingBudget = remainingBudget - take * tier.p
  end
  if quantity == 0 then return 0, 0, nil end
  return quantity, cost, cost / quantity
end

function Core.netIfSold(listPrice, quantity, unitCost, feeRate)
  local fee = feeRate or 0
  return listPrice * quantity * (1 - fee) - unitCost * quantity
end

function Core.sellBreakeven(unitCost, feeRate)
  local fee = feeRate or 0
  if fee >= 1 then return nil end
  return unitCost / (1 - fee)
end

-- Deposit is refunded on sale and lost on expiry/cancel, so the expiry
-- breakeven is the only place it belongs.
function Core.expireBreakeven(unitCost, deposit, quantity, feeRate)
  local fee = feeRate or 0
  if quantity <= 0 or fee >= 1 then return nil end
  return (unitCost * quantity + (deposit or 0)) / (quantity * (1 - fee))
end

-- Hazard rate priors per phase and market type, expressed as expected
-- sales per hour as a share of listed supply.
local PRIOR_HAZARD = {
  ignition = { commodity = 0.35, item = 0.08 },
  wave = { commodity = 0.2, item = 0.06 },
  settle = { commodity = 0.12, item = 0.04 },
  steady = { commodity = 0.08, item = 0.03 }
}

-- P(fill within horizon). Own sales are the only clean label; public
-- disappearances are a bounded prior. With fewer than three own samples
-- the output is an interval, never a point dressed up as precision.
function Core.fillProbability(input)
  local horizon = input.horizonHours or 24
  local phase = input.phase or "steady"
  local marketType = input.marketType or "commodity"
  local samples = input.samples or 0
  local sold = input.sold or 0
  local supply = input.supply or 0
  local elapsed = math.max(input.elapsedHours or 0.25, 0.25)
  local hazard
  local spread = 0.5
  if samples >= 3 and sold > 0 and supply > 0 then
    hazard = sold / (supply * elapsed)
    hazard = math.max(0.001, math.min(hazard, 2))
    if samples >= 6 then spread = 0.2 end
  else
    local phasePriors = PRIOR_HAZARD[phase] or PRIOR_HAZARD.steady
    hazard = phasePriors[marketType] or phasePriors.commodity
  end
  local point = 1 - math.exp(-hazard * horizon)
  local low = math.max(0, point * (1 - spread))
  local high = math.min(1, point * (1 + spread))
  return low, high, point
end

function Core.phaseFor(ageHours, breadth, boundaries)
  local limits = boundaries or (WAH.RULES and WAH.RULES.phaseBoundaries) or {}
  if ageHours < (limits.ignitionHours or 6) or breadth < (limits.ignitionBreadth or 80) then
    return "ignition"
  end
  if ageHours < (limits.waveHours or 48) or breadth < (limits.waveBreadth or 400) then
    return "wave"
  end
  if ageHours < (limits.settleHours or 168) or breadth < (limits.settleBreadth or 800) then
    return "settle"
  end
  return "steady"
end

-- Commodities are anonymous offer groups; item auctions are unique lots.
-- The modern client exposes the distinction through GetItemKeyInfo, but a
-- replicate row does not carry it, so classify from the item record and
-- let the caller override with an explicit marketType.
function Core.marketTypeFor(item)
  if item.marketType then return item.marketType end
  local class = item.itemClass or ""
  if class == "Trade Goods" or class == "商品" or class == "Commodity"
    or class == "Reagent" or class == "材料" then
    return "commodity"
  end
  if item.numAuctions and item.numAuctions > 0 and item.quantity
    and item.quantity / item.numAuctions > 1.5 then
    return "commodity"
  end
  return "item"
end

function Core.confidenceFor(samples, sellers, executable, phase)
  if phase == "ignition" then
    -- Ignition has no history by construction; confidence comes from
    -- breadth of the book, not from a series that cannot exist yet.
    if sellers >= 3 and executable >= 3 then return "medium" end
    return "low"
  end
  if samples >= 12 and sellers >= 3 and executable >= 5 then return "high" end
  if samples >= 6 and sellers >= 2 and executable >= 2 then return "medium" end
  return "low"
end

local CONFIDENCE_WEIGHT = { high = 1, medium = 0.75, low = 0.45 }

local function scoreFor(phase, row, supplyGrowth)
  if row.vendor then return math.huge end
  local fill = row.fillProb or 0
  local confidence = CONFIDENCE_WEIGHT[row.confidence] or 0.45
  if phase == "ignition" then
    -- No history: rank by absolute net times the prior fill chance.
    return row.netProfit * fill
  elseif phase == "wave" then
    -- Supply is still arriving; a fast-decaying edge is not an edge.
    return row.netProfit * fill / math.max(supplyGrowth or 0.1, 0.1)
  end
  return row.netProfit * fill * confidence
end

local function reasonFor(row)
  if row.vendor then
    return string.format("NPC 收购价高于挂单价，%d 件净赚 %d 铜", row.execQty, row.netProfit)
  end
  return string.format("价差 %.0f%%，可买 %d 件，24 小时成交率约 %.0f%%",
    row.spreadPercent, row.execQty, (row.fillProb or 0) * 100)
end

-- Evaluate one market state.
--
-- input:
--   now              epoch seconds
--   phaseOverride    optional phase name
--   rules            WAH.RULES (compiled constants)
--   market           { firstScanAt, items = { [id] = item }, bids = {} }
--   capital          { cash, mail, escrow, budget }
--   capacity         { bagSlots, stackSize }
--   positions        { [itemId] = { qty, cost } }
--
-- output:
--   { phase, rows, actions, diagnostics }
function Core.evaluate(input)
  local rules = input.rules or (WAH.RULES) or {}
  local now = input.now or 0
  local market = input.market or {}
  local items = market.items or {}
  local capital = input.capital or {}
  local capacity = input.capacity or {}
  local positions = input.positions or {}
  local feeRate = rules.feeRate or 0.05

  local breadth = 0
  for _, item in pairs(items) do
    if item.minPrice and item.minPrice > 0 then breadth = breadth + 1 end
  end
  local firstScanAt = market.firstScanAt or now
  local ageHours = math.max(0, (now - firstScanAt) / 3600)
  local phase = input.phaseOverride
    or Core.phaseFor(ageHours, breadth, rules.phaseBoundaries)
  historyRule = (rules.phaseHistory or {})[phase] or { windowHours = 0, minSamples = 0 }
  local typeRules = ((rules.marketTypeRules or {})[phase]) or {}
  local bagSlots = capacity.bagSlots or 20
  local stackSize = capacity.stackSize or 20
  local bagCapacity = bagSlots * stackSize
  local budget = capital.budget or capital.cash or 0

  local rows = {}
  local excluded = { noBook = 0, thinBook = 0, noHistory = 0, spread = 0, net = 0, noDepth = 0 }

  for itemId, item in pairs(items) do
    local minPrice = item.minPrice
    local tiers = item.tiers
    if not (minPrice and minPrice > 0 and tiers and #tiers > 0) then
      excluded.noBook = excluded.noBook + 1
    else
      local marketType = Core.marketTypeFor(item)
      local marketRules = typeRules[marketType] or typeRules.item
      local sellers = item.sellers or item.numAuctions or 0
      if item.sellersInvisible then sellers = item.numAuctions or sellers end
      local listings = item.numAuctions or 0
      local sellP = item.sellP or Core.sellFront(tiers, {
        rules = rules.sellFront,
        byCount = marketType == "item",
        early = phase == "ignition"
      })
      local vendorP = item.vendorP or 0
      local listP = math.max(vendorP + 1, (sellP or minPrice) - (rules.sellFront and rules.sellFront.undercutCopper or 1))

      -- Class 1: vendor arbitrage. The NPC always buys, so no history,
      -- no spread window and no profit floor apply. Budget and bag space
      -- are the only limits.
      if vendorP > minPrice then
        local qty, cost = Core.executableQty(tiers, vendorP, budget, bagCapacity)
        if qty > 0 then
          local net = (vendorP - cost / qty) * qty
          local row = {
            itemId = itemId,
            name = item.name,
            quality = item.quality,
            marketType = marketType,
            vendor = true,
            minPrice = minPrice,
            ladderPrice = cost / qty,
            execQty = qty,
            sellP = vendorP,
            listP = vendorP,
            spreadPercent = (1 - minPrice / vendorP) * 100,
            netProfit = round(net),
            netPerUnit = round(vendorP - cost / qty),
            fillProb = 1,
            fillProbLow = 1,
            fillProbHigh = 1,
            confidence = "high",
            supplyGrowth = 0,
            bidOnly = item.bidOnly or 0
          }
          row.reason = reasonFor(row)
          row.score = scoreFor(phase, row, 0)
          rows[#rows + 1] = row
        else
          excluded.noDepth = excluded.noDepth + 1
        end
      else
        local history = item.history or {}
        local samples = history.samples or 0
        local reference = history.sellRef or sellP
        local spread = reference and reference > 0 and (reference - minPrice) / reference or 0
        local priceCap = listP * (1 - feeRate) - (marketRules and marketRules.minUnitProfit or 0)
        local qty, cost, average = Core.executableQty(tiers, priceCap, budget, bagCapacity)
        local net = qty > 0 and Core.netIfSold(listP, qty, cost / qty, feeRate) or 0
        if listings < ((marketRules and marketRules.minListings) or 1) then
          excluded.thinBook = excluded.thinBook + 1
        elseif sellers < ((marketRules and marketRules.minSellers) or 1) then
          excluded.thinBook = excluded.thinBook + 1
        elseif samples < historyRule.minSamples then
          excluded.noHistory = excluded.noHistory + 1
        elseif qty <= 0 or priceCap < minPrice then
          excluded.noDepth = excluded.noDepth + 1
        elseif spread < ((marketRules and marketRules.minSpread) or 0)
          or spread > ((marketRules and marketRules.maxSpread) or 1) then
          excluded.spread = excluded.spread + 1
        elseif net < ((marketRules and marketRules.minNet) or 0) then
          excluded.net = excluded.net + 1
        else
          local low, high, point = Core.fillProbability({
            horizonHours = 24,
            phase = phase,
            marketType = marketType,
            samples = samples,
            sold = item.inferredSold or 0,
            supply = item.quantity or 0,
            elapsedHours = item.elapsedHours or 0.25
          })
          local confidence = Core.confidenceFor(samples, sellers, qty, phase)
          local row = {
            itemId = itemId,
            name = item.name,
            quality = item.quality,
            marketType = marketType,
            vendor = false,
            minPrice = minPrice,
            ladderPrice = average,
            execQty = qty,
            sellP = sellP,
            listP = listP,
            spreadPercent = spread * 100,
            netProfit = round(net),
            netPerUnit = round(net / qty),
            fillProb = point,
            fillProbLow = low,
            fillProbHigh = high,
            confidence = confidence,
            supplyGrowth = item.supplyGrowth or 0,
            bidOnly = item.bidOnly or 0
          }
          row.reason = reasonFor(row)
          row.score = scoreFor(phase, row, item.supplyGrowth)
          rows[#rows + 1] = row
        end
      end
    end
  end

  table.sort(rows, function(left, right)
    if left.vendor ~= right.vendor then return left.vendor end
    if left.score ~= right.score then return left.score > right.score end
    if left.netProfit ~= right.netProfit then return left.netProfit > right.netProfit end
    return left.itemId < right.itemId
  end)

  -- Conditional plans, not a bare action queue: each buy carries the
  -- abort condition, and each held position carries its sell plan.
  local actions = {}
  for index, row in ipairs(rows) do
    if index > 12 then break end
    if row.vendor then
      actions[#actions + 1] = {
        kind = "buy",
        itemId = row.itemId,
        name = row.name,
        qty = row.execQty,
        maxUnitPrice = row.sellP,
        expectedNet = row.netProfit,
        fillProb = 1,
        confidence = row.confidence,
        exit = "vendor",
        reason = row.reason
      }
    else
      actions[#actions + 1] = {
        kind = "buy",
        itemId = row.itemId,
        name = row.name,
        qty = row.execQty,
        maxUnitPrice = round(row.listP * (1 - feeRate)),
        expectedNet = row.netProfit,
        fillProb = row.fillProb,
        confidence = row.confidence,
        exit = "auction",
        stop = {
          kind = "abort",
          ifPriceAbove = round(row.listP * (1 - feeRate))
        },
        reason = row.reason
      }
    end
  end
  for itemId, position in pairs(positions) do
    if position.qty and position.qty > 0 then
      local item = items[itemId]
      local sellP = item and (item.sellP or Core.sellFront(item.tiers or {}, { rules = rules.sellFront }))
      if sellP then
        actions[#actions + 1] = {
          kind = "sell",
          itemId = itemId,
          qty = position.qty,
          price = math.max((item and item.vendorP or 0) + 1, sellP - (rules.sellFront and rules.sellFront.undercutCopper or 1)),
          netIfSold = round(Core.netIfSold(sellP, position.qty, position.cost / position.qty, feeRate)),
          reason = "持仓卖出计划"
        }
      end
    end
  end

  return {
    phase = phase,
    ageHours = ageHours,
    breadth = breadth,
    dataAgeMinutes = math.max(0, (now - (market.scannedAt or now)) / 60),
    rows = rows,
    actions = actions,
    diagnostics = {
      considered = breadth,
      matched = #rows,
      excluded = excluded
    }
  }
end

-- Sell-side plan for one item and one batch. The client computes the
-- deposit (it owns the API); this function owns the fee and breakeven
-- arithmetic so the panel and the terminal cannot disagree.
function Core.sellPlan(item, position, rules, opts)
  local config = rules or (WAH.RULES) or {}
  local feeRate = config.feeRate or 0.05
  local sellP = item.sellP or Core.sellFront(item.tiers or {}, { rules = config.sellFront })
  if not sellP then return nil end
  local undercut = (config.sellFront and config.sellFront.undercutCopper) or 1
  local listP = math.max((item.vendorP or 0) + 1, sellP - undercut)
  local quantity = position.qty or 1
  local unitCost = position.cost and position.cost / quantity or 0
  local deposit = (opts and opts.deposit) or 0
  return {
    itemId = item.itemId,
    quantity = quantity,
    sellP = sellP,
    listP = listP,
    unitCost = unitCost,
    deposit = deposit,
    netIfSold = round(Core.netIfSold(listP, quantity, unitCost, feeRate)),
    sellBreakeven = round(Core.sellBreakeven(unitCost, feeRate) or 0),
    expireBreakeven = round(Core.expireBreakeven(unitCost, deposit, quantity, feeRate) or 0),
    lossIfExpired = round(deposit + unitCost * quantity),
    feeIfSold = round(listP * quantity * feeRate)
  }
end

WAH.Core = Core
