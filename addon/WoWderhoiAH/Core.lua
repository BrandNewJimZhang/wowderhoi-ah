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

local function round(value) return math.floor(value + 0.5) end

-- The elapsed-time floor is the compiled scan cadence. A gap shorter than
-- one scan interval is a manual rescan, not a rate the model should
-- extrapolate; the scanner, the ledger and the terminal importer all read
-- the same constant, so both sides estimate the same hazard from the same
-- pair of scans.
local function scanFloorHours()
  return ((WAH.RULES and WAH.RULES.scanIntervalMinutes) or 15) / 60
end

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
    local depth = math.min(rules.itemDepth or 3, #filtered)
    return filtered[math.max(depth, 1)].p
  end
  local alpha = rules.alpha or 0.03
  local minDepth = rules.minDepth or 3
  if opts and opts.early then minDepth = rules.minDepthEarly or 1 end
  local target = math.max(minDepth, math.ceil(filteredTotal * alpha))
  local cumulative = 0
  for _, tier in ipairs(filtered) do
    cumulative = cumulative + tier.q
    if cumulative >= target then return tier.p end
  end
  return filtered[#filtered].p
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

-- One authority for the listing price. The floor keeps the listing above
-- the vendor price; the undercut is a compiled rule, not a local constant.
function Core.listPrice(sellP, vendorP, rules)
  local undercut = (rules and rules.sellFront and rules.sellFront.undercutCopper) or 1
  return math.max((vendorP or 0) + 1, (sellP or 0) - undercut)
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

-- P(fill within horizon). There are three evidence tiers, in order:
--
--   own     Units the player actually sold. The only clean label the client
--           ever gives. Sell-through rate is units/hour; a listing of q
--           units therefore clears at hazard = rate / q (the queue model).
--   proxy   Public disappearances between scans. A bounded inference that
--           cannot separate sales from cancellations, so it is weaker.
--   prior   The phase x market-type table. Used when nothing is observable.
--
-- Fewer than three own sales is not evidence; the output is always an
-- interval, never a point dressed up as precision.
function Core.fillProbability(input)
  local horizon = input.horizonHours or 24
  local phase = input.phase or "steady"
  local marketType = input.marketType or "commodity"
  local ownSold = input.ownSold or 0
  local ownSamples = input.ownSamples or 0
  local sold = input.sold or 0
  local supply = input.supply or 0
  local floor = scanFloorHours()
  local elapsed = math.max(input.elapsedHours or floor, floor)
  local hazard, basis, spread
  if ownSamples >= 3 and ownSold > 0 then
    local rate = ownSold / math.max(input.ownElapsedHours or 1, floor)
    local quantity = math.max(input.qty or 1, 1)
    hazard = rate / quantity
    basis = "own"
    spread = ownSamples >= 6 and 0.2 or 0.35
  elseif sold > 0 and supply > 0 then
    hazard = sold / (supply * elapsed)
    basis = "proxy"
    spread = 0.5
  else
    local phasePriors = PRIOR_HAZARD[phase] or PRIOR_HAZARD.steady
    hazard = phasePriors[marketType] or phasePriors.commodity
    basis = "prior"
    spread = 0.5
  end
  hazard = math.max(0.001, math.min(hazard, 2))
  local point = 1 - math.exp(-hazard * horizon)
  local low = math.max(0, point * (1 - spread))
  local high = math.min(1, point * (1 + spread))
  -- The hazard is returned so a chart can anchor its curve to this estimate
  -- instead of inverting a point that the cap can round to exactly 1.
  return low, high, point, basis, hazard
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

-- Demand prior for the opening weeks. The table is generated from
-- src/data/demand-bands.json; a missing match is neutral (1.0).
function Core.demandFor(category, subCategory)
  local function matches(names, value)
    for _, name in ipairs(names or {}) do
      if name == "*" then return true end
      if value and name:lower() == value:lower() then return true end
    end
    return false
  end
  for _, band in ipairs(WAH.DEMAND or {}) do
    if matches(band.classes, category) and matches(band.subClasses, subCategory) then
      return band.weight or 1
    end
  end
  return 1
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
    -- No history: rank by absolute net times the prior fill chance and
    -- the structural demand prior.
    return row.netProfit * fill * (row.demandPrior or 1)
  elseif phase == "wave" then
    -- Supply is still arriving; a fast-decaying edge is not an edge.
    return row.netProfit * fill / math.max(supplyGrowth or 0.1, 0.1)
  end
  return row.netProfit * fill * confidence
end

local FILL_BASIS_TEXT = {
  own = "成交率来自自己的成交",
  proxy = "成交率来自公共推断",
  prior = "成交率来自阶段先验"
}

local function reasonFor(row)
  if row.vendor then
    return string.format("NPC 收购价高于挂单价，%d 件净赚 %d 铜", row.execQty, row.netProfit)
  end
  local low = (row.fillProbLow or row.fillProb or 0) * 100
  local high = (row.fillProbHigh or row.fillProb or 0) * 100
  local text = string.format("价差 %.0f%%，可买 %d 件，每件净利 %d 铜，24 小时成交率 %.0f%%（%.0f–%.0f%%，%s）",
    row.spreadPercent, row.execQty, row.netPerUnit or 0, (row.fillProb or 0) * 100, low, high,
    FILL_BASIS_TEXT[row.fillBasis or "prior"] or FILL_BASIS_TEXT.prior)
  if row.bidOnly and row.bidOnly > 0 then
    text = text .. string.format("，另有 %d 笔竞价", row.bidOnly)
  end
  if row.inferredSoldHigh and row.inferredSoldHigh > 0 then
    local low = row.inferredSoldLow or 0
    local high = row.inferredSoldHigh
    text = text .. (low == high
      and string.format("，推断消失 %d 件", low)
      or string.format("，推断消失 %d–%d 件", low, high))
  end
  return text
end

-- Evaluate one market state.
--
-- input:
--   now              epoch seconds
--   phaseOverride    optional phase name
--   rules            WAH.RULES (compiled constants)
--   market           { firstScanAt, items = { [id] = item } }
--   capital          { cash, mail, escrow, budget }
--   capacity         { bagSlots, stackSize }
--   positions        { [itemId] = { qty, cost } }
--
-- output:
--   { phase, rows, actions, diagnostics }
function Core.evaluate(input)
  -- Rules are compiled constants shared by both runtimes; the input carries
  -- the market state, never a second copy of the rules.
  local rules = WAH.RULES or {}
  local now = input.now or 0
  local market = input.market or {}
  local items = market.items or {}
  local capital = input.capital or {}
  local capacity = input.capacity or {}
  local positions = input.positions or {}
  local feeRate = rules.feeRate or 0.05
  local scanFloor = scanFloorHours()

  local breadth = 0
  for _, item in pairs(items) do
    if item.minPrice and item.minPrice > 0 then breadth = breadth + 1 end
  end
  local firstScanAt = market.firstScanAt or now
  local ageHours = math.max(0, (now - firstScanAt) / 3600)
  local phase = input.phaseOverride
    or Core.phaseFor(ageHours, breadth, rules.phaseBoundaries)
  local historyRule = (rules.phaseHistory or {})[phase] or { windowHours = 0, minSamples = 0 }
  local typeRules = ((rules.marketTypeRules or {})[phase]) or {}
  local bagSlots = capacity.bagSlots or 20
  local stackSize = capacity.stackSize or 20
  local bagCapacity = bagSlots * stackSize
  -- The planning budget is a cap, never a substitute for cash: a scan that
  -- reports 30k in the purse cannot fund a 94k ladder. Both runtimes feed
  -- the same fields, so the bound belongs here rather than in one caller.
  local cash = capital.cash or 0
  local requested = capital.budget or 0
  if requested <= 0 then requested = cash end
  local budget = cash > 0 and math.min(requested, cash) or requested

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
      -- The scan prices the front once, with the market type and phase it
      -- recorded. The core consumes that number; re-deriving it here would
      -- let the same book produce a different front from a thinner ladder.
      local sellP = item.sellP
      local vendorP = item.vendorP or 0
      local listP = Core.listPrice(sellP or minPrice, vendorP, rules)

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
            fillBasis = "vendor",
            confidence = "high",
            supplyGrowth = 0,
            bidOnly = item.bidOnly or 0,
            inferredSoldLow = 0,
            inferredSoldHigh = 0,
            demandPrior = item.demandPrior or 1
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
        -- The gate measures the trade you can execute now: buy at minPrice,
        -- resell at the live sell front. A historical median is context for
        -- the trend, never the reference a spread is measured against.
        local spread = sellP and sellP > 0 and (sellP - minPrice) / sellP or 0
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
          local low, high, point, fillBasis, fillHazard = Core.fillProbability({
            horizonHours = 24,
            phase = phase,
            marketType = marketType,
            qty = qty,
            ownSold = item.ownSold or 0,
            ownSamples = item.ownSamples or 0,
            ownElapsedHours = item.ownElapsedHours or 0,
            sold = item.inferredSoldLow or 0,
            supply = item.quantity or 0,
            elapsedHours = item.elapsedHours or scanFloor
          })
          local confidence = Core.confidenceFor(samples, sellers, qty, phase)
          -- No fill evidence at all: history depth can still make the trade
          -- actionable, but it cannot make the fill estimate high-confidence.
          if fillBasis == "prior" and confidence == "high" then confidence = "medium" end
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
            fillHazard = fillHazard,
            fillBasis = fillBasis,
            confidence = confidence,
            supplyGrowth = item.supplyGrowth or 0,
            bidOnly = item.bidOnly or 0,
            inferredSoldLow = item.inferredSoldLow or 0,
            inferredSoldHigh = item.inferredSoldHigh or 0,
            demandPrior = item.demandPrior or 1
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
      local sellP = item and item.sellP
      if sellP then
        -- Net against the price the listing will carry, not the raw front:
        -- the undercut is real money and the two must not disagree.
        local price = Core.listPrice(sellP, item and item.vendorP or 0, rules)
        actions[#actions + 1] = {
          kind = "sell",
          itemId = itemId,
          qty = position.qty,
          price = price,
          netIfSold = round(Core.netIfSold(price, position.qty, position.cost / position.qty, feeRate)),
          reason = "持仓卖出计划"
        }
      end
    end
  end

  return {
    phase = phase,
    rows = rows,
    actions = actions,
    -- Why rows fell out of the radar, keyed by gate. The UIs explain
    -- exclusions per row; the core's own tests read this table.
    diagnostics = { excluded = excluded }
  }
end

-- Sell-side plan for one item and one batch. The client computes the
-- deposit (it owns the API); this function owns the fee and breakeven
-- arithmetic so the panel and the terminal cannot disagree.
function Core.sellPlan(item, position, rules, opts)
  local config = rules or (WAH.RULES) or {}
  local feeRate = config.feeRate or 0.05
  local sellP = item.sellP
  if not sellP then return nil end
  local listP = Core.listPrice(sellP, item.vendorP, config)
  local quantity = position.qty or 1
  local unitCost = position.cost and position.cost / quantity or 0
  local deposit = (opts and opts.deposit) or 0
  -- An expired listing returns the goods, so the loss is the deposit plus
  -- the gap between cost and the guaranteed NPC floor, not the whole cost.
  local residual = (item.vendorP or 0) * quantity
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
    lossIfExpired = round(deposit + math.max(0, unitCost * quantity - residual)),
    feeIfSold = round(listP * quantity * feeRate)
  }
end

WAH.Core = Core
