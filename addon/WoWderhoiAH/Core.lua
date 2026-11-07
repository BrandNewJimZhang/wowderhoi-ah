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

-- Percentile of a ladder the caller already built with `sortedTiers` (or
-- the scanner's aggregateTiers, which produces the same shape). Scanning
-- prices thousands of books per scan; re-copying and re-sorting the same
-- ladder for P5, P10 and the sell front is pure garbage.
function Core.percentileOfSorted(sorted, fraction)
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
--
-- `sorted` must be price-sorted and validated (Core.sortedTiers or the
-- scanner's aggregateTiers). The scanner prices every item on every scan;
-- handing it the book it just built avoids a second copy-and-sort.
function Core.sellFrontSorted(sorted, opts)
  local rules = (opts and opts.rules) or (WAH.RULES and WAH.RULES.sellFront) or {}
  local total = Core.totalQuantity(sorted)
  if total <= 0 then return nil end
  local noiseMultiple = rules.noiseMultiple or 3
  local median = Core.percentileOfSorted(sorted, 0.5)
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

function Core.sellFront(tiers, opts)
  return Core.sellFrontSorted(Core.sortedTiers(tiers), opts)
end

-- Largest quantity the player can actually buy under a price cap, a
-- budget and a quantity ceiling (bag space, or the row's executable depth
-- when the allocator is splitting one purse). Returns quantity, total cost
-- and average price.
--
-- `sorted` must already be price-ascending. The evaluator walks thousands
-- of books per scan and both builders (the scanner's aggregateTiers and the
-- terminal's parseTiers) emit this order, so re-copying and re-sorting the
-- ladder here would cost more than the walk itself.
function Core.executableQtySorted(sorted, priceCap, budget, quantityCap)
  local quantity, cost = 0, 0
  local remainingBudget = math.floor(budget or 0)
  for _, tier in ipairs(sorted) do
    if priceCap and priceCap > 0 and tier.p > priceCap then break end
    if remainingBudget <= 0 then break end
    if quantityCap and quantity >= quantityCap then break end
    local take = tier.q
    if quantityCap then take = math.min(take, quantityCap - quantity) end
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

-- Cost of buying exactly `quantity` units, cheapest offers first. Returns
-- nil when the visible book cannot fill the order: the callers quote a price
-- they could not pay otherwise. The UI's purchase estimate and the core's
-- ladder walk must agree, so this is the only quantity-walk authority.
function Core.ladderCost(tiers, quantity)
  if not quantity or quantity <= 0 then return 0 end
  local remaining, cost = quantity, 0
  for _, tier in ipairs(Core.sortedTiers(tiers)) do
    local take = math.min(remaining, tier.q)
    cost = cost + take * tier.p
    remaining = remaining - take
    if remaining <= 0 then return cost end
  end
  return nil
end

function Core.netIfSold(listPrice, quantity, unitCost, feeRate)
  local fee = feeRate or 0
  return listPrice * quantity * (1 - fee) - unitCost * quantity
end

-- One authority for the listing price. The floor keeps the listing above
-- the vendor price; the undercut is a compiled rule, not a local constant.
-- The result is whole copper: commodity tier prices are buyout/count and
-- can be fractional, but the client posts in copper and the journal must
-- record the price it actually posted at.
function Core.listPrice(sellP, vendorP, rules)
  local undercut = (rules and rules.sellFront and rules.sellFront.undercutCopper) or 1
  return math.max((vendorP or 0) + 1, math.floor((sellP or 0) - undercut))
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

-- Hazard rate priors per phase and market type live in the rule source
-- (src/lib/market-rules.ts -> GeneratedRules.lua). The core reads the
-- compiled copy and refuses to run without it: a second hard-coded table
-- here would drift from the one the calibration script edits.
local function fillPriorRules()
  local compiled = WAH.RULES and WAH.RULES.fillPrior
  if type(compiled) ~= "table" or type(compiled.hazard) ~= "table"
    or type(compiled.priorStrengthHours) ~= "number" then
    error("WAH.RULES.fillPrior missing: run `npm run gen:lua-rules`")
  end
  return compiled
end

-- The window every fill chance is quoted for. The radar, the item chart,
-- the sell page and the terminal's calibration must use the same one; the
-- review page used to measure outcomes over 72h against a 24h prediction.
local function fillHorizonHours()
  local fill = WAH.RULES and WAH.RULES.fill
  return (fill and fill.horizonHours) or 24
end

-- Units listed at or below `price`, excluding the player's own listings
-- (the scan already removed them). Used by both the fill model and the
-- sell plan so a listing's queue is measured the same way in each.
local function quantityAtOrBelow(tiers, price)
  local total = 0
  for _, tier in ipairs(tiers or {}) do
    if tier.p and tier.p <= price then total = total + (tier.q or 0) end
  end
  return total
end

-- P(a listing clears within `hours`). `share` is a fraction of the book
-- per hour -- the unit the calibration script measures and the rule source
-- stores -- never a per-listing rate. Units leave at share x supply per
-- hour; a listing of `quantity` units joins the queue behind `ahead` units
-- already priced at or below it, so it clears when that whole queue has
-- left. The radar, the terminal chart and the sell plan all call this one
-- function; a second rearrangement of the same formula is how the sell
-- page and the radar came to quote different probabilities for one item.
--
-- Without a book size there is no queue to be behind, so the share is
-- applied to the listing itself -- the conservative reading of the same
-- number, used by callers that have no supply yet.
function Core.fillWithin(share, supply, ahead, quantity, hours)
  local rateShare = math.max(share or 0, 0)
  if rateShare <= 0 or (hours or 0) <= 0 then return 0 end
  local book = math.max(supply or 0, 0)
  if book <= 0 then
    return 1 - math.exp(-rateShare * hours)
  end
  local queue = math.max(ahead or 0, 0) + math.max(quantity or 0, 1)
  return 1 - math.exp(-rateShare * book * hours / queue)
end

-- P(fill within horizon). There are four evidence tiers, in order:
--
--   own            Units the player actually sold. The only clean label the
--                  client ever gives. The sale rate is units/hour; dividing
--                  by the book turns it into the same share the other tiers
--                  report, and Core.fillWithin turns it back into units/hour.
--   proxy          Public disappearances between scans. A bounded inference
--                  that cannot separate sales from cancellations.
--   observed-zero  The book was observable and nothing left it. That is
--                  evidence of a slow mover, not missing data: the prior is
--                  shrunk by the exposure instead of replacing it.
--   prior          Nothing observable (owners hidden). The phase x market
--                  type table carries the estimate.
--
-- The returned hazard is always a share of the book per hour. `ahead` is
-- the queue in front of the listing (zero when the caller does not model
-- one); Core.fillWithin applies both to the listing.
--
-- Fewer than three own sales is not evidence; the output is always an
-- interval, never a point dressed up as precision.
function Core.fillProbability(input)
  local horizon = input.horizonHours or fillHorizonHours()
  local phase = input.phase or "steady"
  local marketType = input.marketType or "commodity"
  local ownSold = input.ownSold or 0
  local ownSamples = input.ownSamples or 0
  local sold = input.sold or 0
  local supply = input.supply or 0
  local floor = scanFloorHours()
  local elapsed = math.max(input.elapsedHours or floor, floor)
  local prior = fillPriorRules()
  local phasePriors = prior.hazard[phase] or prior.hazard.steady
  local priorHazard = phasePriors[marketType] or phasePriors.commodity
  local priorStrength = prior.priorStrengthHours
  local hazard, basis, spread
  if ownSamples >= 3 and ownSold > 0 then
    -- Units per exposed hour: each sale contributes the time its listing
    -- spent on the book, not the span between the first and last sale.
    -- The sale rate is units/hour, so it becomes a book share by dividing
    -- by the book; the queue formula then turns it back into the same
    -- units/hour. Without a book size it stays a per-listing rate.
    local rate = ownSold / math.max(input.ownExposedHours or 1, floor)
    local quantity = math.max(input.qty or 1, 1)
    hazard = supply > 0 and rate / supply or rate / quantity
    basis = "own"
    spread = ownSamples >= 6 and 0.2 or 0.35
  elseif input.observable == true and supply > 0 then
    -- Gamma-Poisson shrink: the prior contributes its weight in unit-hours,
    -- the observation contributes units. A zero observation over a large
    -- exposed book pulls the posterior far below the prior; a busy book
    -- overrides it. Units: hazard [1/h], priorHazard * priorStrength
    -- [units], priorStrength + supply * elapsed [units].
    hazard = (priorHazard * priorStrength + sold) / (priorStrength + supply * elapsed)
    basis = sold > 0 and "proxy" or "observed-zero"
    spread = 0.5
  elseif sold > 0 and supply > 0 then
    hazard = sold / (supply * elapsed)
    basis = "proxy"
    spread = 0.5
  else
    hazard = priorHazard
    basis = "prior"
    spread = 0.5
  end
  hazard = math.max(0.001, math.min(hazard, 2))
  local point = Core.fillWithin(hazard, supply, input.ahead, input.qty, horizon)
  local low = math.max(0, point * (1 - spread))
  local high = math.min(1, point * (1 + spread))
  -- The hazard is returned so a chart can anchor its curve to this estimate
  -- instead of inverting a point that the cap can round to exactly 1.
  return low, high, point, basis, hazard
end

-- A book is observable only when every row named its owner AND the scan had
-- a previous capture of this item to diff against. A partially hidden book
-- reports an empty lower edge by construction, and so does an item that was
-- just listed; both are missing data, not evidence that nothing sold. The
-- radar and the sell planner must make the same call.
function Core.isObservable(item)
  return item ~= nil and item.ownerVisible == true and not item.sellersInvisible
    and item.flowObserved ~= false
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

-- Demand multiplier for a scheduled event window. Generated from
-- src/data/events.json into WAH.EVENTS; an entry with startsAt 0 is a
-- template and never matches. Only the ranking prior is scaled: an event
-- must not relax a gate or invent a price.
function Core.eventBoost(now, category, subCategory)
  local function matchesAny(names, value)
    local list = names or {}
    -- An empty restriction list means "all", not "none": an event that only
    -- narrows the subcategory must still apply. The two lists used to
    -- disagree here, so such an entry silently matched nothing.
    if #list == 0 then return true end
    for _, name in ipairs(list) do
      if name == "*" or (value and name:lower() == value:lower()) then return true end
    end
    return false
  end
  local boost = 1
  for _, event in ipairs(WAH.EVENTS or {}) do
    local startAt = (event.startsAt or 0) - (event.leadHours or 0) * 3600
    local endAt = event.endsAt or event.startsAt or 0
    if (event.startsAt or 0) > 0 and now >= startAt and now <= endAt
      and matchesAny(event.classes, category) and matchesAny(event.subClasses, subCategory) then
      boost = boost * (event.weight or 1)
    end
  end
  return boost
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

-- Effort per action, from the compiled rule source. A buy pays the round
-- trip plus the purchase; a post pays the round trip plus the listing. One
-- helper, so ranking and both cockpits measure the same minutes.
local function effortMinutes(kind)
  local timeCost = (WAH.RULES and WAH.RULES.timeCost) or {}
  local minutes = timeCost.overheadMinutes or 10
  if kind == "sell" then
    return minutes + (timeCost.postMinutes or 2)
  end
  return minutes + (timeCost.buyMinutes or 2)
end

local function scoreFor(phase, row, supplyGrowth)
  if row.vendor then return math.huge end
  local fill = row.fillProb or 0
  local confidence = CONFIDENCE_WEIGHT[row.confidence] or 0.45
  -- A book one seller controls can be repriced under the position; the
  -- measure only exists when owners are visible.
  local concentration = 1
  if row.sellerHHI then
    local weight = (WAH.RULES and WAH.RULES.concentration and WAH.RULES.concentration.weight) or 0.15
    concentration = 1 - weight * row.sellerHHI
  end
  -- Net per minute of play. Ranking divides by the effort a trade costs;
  -- an opportunity that takes several trips must clear a higher bar.
  local base
  if phase == "ignition" then
    -- No history: rank by absolute net times the prior fill chance and
    -- the structural demand prior.
    base = row.candidateNet * fill * (row.demandPrior or 1)
  elseif phase == "wave" then
    -- Supply is still arriving; a fast-decaying edge is not an edge.
    base = row.candidateNet * fill / math.max(supplyGrowth or 0.1, 0.1)
  else
    base = row.candidateNet * fill * confidence
  end
  return base * concentration / math.max(effortMinutes("buy"), 1)
end

local FILL_BASIS_TEXT = {
  own = "成交率来自自己的成交",
  proxy = "成交率来自公共推断",
  ["observed-zero"] = "两次扫描均无消失，成交率按零观测收缩",
  prior = "成交率来自阶段先验"
}

local function reasonFor(row)
  if row.vendor then
    return string.format("NPC 收购价高于挂单价，全预算可执行 %d 件净赚 %d 铜", row.candidateQty, row.candidateNet)
  end
  local low = (row.fillProbLow or row.fillProb or 0) * 100
  local high = (row.fillProbHigh or row.fillProb or 0) * 100
  -- "可买" is the allocated column; the reason quotes the full-budget
  -- candidate, so it says so rather than using the same word for two
  -- different quantities.
  local text = string.format("价差 %.0f%%，全预算可执行 %d 件，每件净利 %d 铜，%d 小时成交率 %.0f%%（%.0f–%.0f%%，%s）",
    row.spreadPercent, row.candidateQty, row.candidateNetPerUnit or 0, fillHorizonHours(),
    (row.fillProb or 0) * 100, low, high,
    FILL_BASIS_TEXT[row.fillBasis or "prior"] or FILL_BASIS_TEXT.prior)
  if row.bidOnly and row.bidOnly > 0 then
    text = text .. string.format("，另有 %d 笔竞价", row.bidOnly)
    if (row.highestBid or 0) > 0 then
      text = text .. string.format("（最高 %d 铜）", row.highestBid)
    end
  end
  if (row.sellerHHI or 0) >= 0.5 and row.topSellerShare then
    text = text .. string.format("，卖家集中：最大占 %.0f%%", row.topSellerShare * 100)
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

-- Fractional Kelly for one bet. win and loss are copper per unit; a
-- non-positive edge is no bet, not a short one.
function Core.kellyFraction(p, win, loss)
  if win <= 0 or loss <= 0 then return 0 end
  local odds = win / loss
  local fraction = (p or 0) - (1 - (p or 0)) / odds
  return math.max(0, math.min(1, fraction))
end

-- Budget for one opportunity, capped by the per-item exposure rule.
--
-- The bet is sized at the entry price -- the front of the book, which is
-- what the allocator's first units actually pay -- not at the deep-ladder
-- average. Pricing the whole executable depth made every deep book look
-- like a bet whose upside was only the per-unit floor while its downside
-- was the entire purchase, and Kelly zeroed every realistic row.
--
-- The downside is one observed spread. A failed listing returns the goods,
-- so the stake at risk is a price move against the position, not its full
-- cost: charging cost - NPC value treated every flip as a total write-off,
-- and a 5% margin measured against a 95% loss is not a bet at any fill
-- chance below certainty. The allocator reprices whatever quantity the
-- fraction funds from the cheap end of the same ladder.
function Core.sizePosition(row, deployable, rules)
  local portfolio = (rules and rules.portfolio) or {}
  local feeRate = (rules and rules.feeRate) or 0.05
  local unitCost = row.minPrice or row.candidateUnitPrice or 0
  local capital = math.max(deployable or 0, 0)
  local win = (row.listP or 0) * (1 - feeRate) - unitCost
  local loss = math.max((row.sellP or row.listP or unitCost) - unitCost, 1)
  local fraction = Core.kellyFraction(row.fillProb or 0, win, loss)
    * (portfolio.kellyFraction or 0.25)
  local itemCap = capital * (portfolio.maxItemExposure or 0.25)
  local budget = math.min(capital * fraction, itemCap)
  return {
    budget = budget,
    -- A zero allocation is a sizing decision, not a purse decision; the
    -- caller needs the fraction to say which one it hit.
    fraction = fraction,
    exploratory = (row.samples or 0) < (portfolio.minKellySamples or 10)
  }
end

-- Greedy allocation across the already-ranked rows. Every row used to see
-- the whole budget on its own, so two 60k opportunities could both be
-- recommended to a 100k purse. Allocation only ever reduces a row's
-- executable quantity; the market depth (candidateQty) stays as the ceiling.
function Core.allocate(rows, deployable, rules)
  local portfolio = (rules and rules.portfolio) or {}
  local feeRate = (rules and rules.feeRate) or 0.05
  local remaining = math.max(deployable or 0, 0) * (portfolio.dailyBudget or 0.5)
  -- Why a candidate got no copper. "The purse ran out" is actionable and
  -- the old radar guessed it for every zero; a Kelly rejection or an
  -- exposure cap is a different message.
  local unfunded = { kelly = 0, exposure = 0, purse = 0, depth = 0 }
  for _, row in ipairs(rows) do
    row.allocQty = 0
    row.allocNet = 0
    row.allocCost = 0
    row.netPerMinute = 0
    row.unfunded = nil
    -- The row's buy price: the average actually paid for the allocated
    -- quantity. Before an allocation exists, the deep-ladder average still
    -- describes the book the row was ranked from.
    row.allocUnitPrice = row.candidateUnitPrice or 0
    -- The sample floor is a portfolio rule; the terminal must not re-derive
    -- the "exploratory" label from its own copy of the number.
    row.exploratory = false
    local sized
    local itemCap
    if not row.vendor then
      sized = Core.sizePosition(row, deployable, rules)
      row.exploratory = sized.exploratory
      itemCap = sized.budget
    end
    local unit = row.candidateUnitPrice or 0
    if remaining <= 0 then
      row.unfunded = "purse"
    elseif sized and sized.fraction <= 0 then
      row.unfunded = "kelly"
    elseif itemCap and itemCap <= 0 then
      row.unfunded = "exposure"
    elseif unit <= 0 then
      row.unfunded = "depth"
    else
      local cap = remaining
      if itemCap then cap = math.min(cap, itemCap) end
      -- Quantity is what the copper cap actually reaches down the ladder,
      -- not cap divided by the deep-ladder average: a front-loaded book
      -- (ten units at 100, a hundred at 1,000) can fund ten units with the
      -- same cap that the average would turn into one. candidateQty stays the
      -- ceiling because the row's price limits were already applied to it.
      local qty, cost
      if row.tiers then
        qty, cost = Core.executableQtySorted(row.tiers, nil, cap, row.candidateQty or 0)
      else
        qty = math.min(row.candidateQty or 0, math.floor(cap / unit))
        cost = qty * unit
      end
      if qty > 0 then
        local unitPrice = cost / qty
        row.allocQty = qty
        row.allocCost = round(cost)
        row.allocUnitPrice = unitPrice
        row.allocNet = round(row.vendor
          and (row.sellP - unitPrice) * qty
          or Core.netIfSold(row.listP, qty, unitPrice, feeRate))
        -- Effort-adjusted return: the same coins earned in one trip are
        -- worth more than in four. Displayed by both cockpits.
        row.netPerMinute = round(row.allocNet / math.max(effortMinutes("buy"), 1))
        remaining = remaining - cost
      -- Zero quantity after the ladder walk has two different causes: the
      -- remaining share cannot reach one average unit (the purse ran out
      -- mid-list), or the per-item exposure cap cannot. Only when both caps
      -- clear the row's average yet no rung is affordable is the book itself
      -- the limit.
      elseif remaining < unit then
        row.unfunded = "purse"
      elseif itemCap and itemCap < unit then
        row.unfunded = "exposure"
      else
        row.unfunded = "depth"
      end
    end
    if row.unfunded then unfunded[row.unfunded] = unfunded[row.unfunded] + 1 end
  end
  return rows, unfunded
end

-- Evaluate one market state.
--
-- input:
--   now              epoch seconds
--   phaseOverride    optional phase name
--   rules            WAH.RULES (compiled constants)
--   market           { firstScanAt, items = { [id] = item } }
--                    item.tiers must be price-ascending (both builders sort)
--   capital          { cash, budget } -- cash nil = unknown balance; 0 = empty
--   capacity         { bagSlots, stackSize }
--   positions        { [itemId] = { qty, cost } }
--
-- output:
--   { phase, rows, opportunities, actions, diagnostics }
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
  -- The per-unit ceiling a gate applies: the listing net of the fee, minus
  -- the phase's minimum unit profit. The buy action's abort price must be
  -- this same marginal; break-even would let a player pay a price the gate
  -- already rejected.
  local function unitPriceCap(listP, marketRules)
    return listP * (1 - feeRate) - ((marketRules and marketRules.minUnitProfit) or 0)
  end
  local bagSlots = capacity.bagSlots or 20
  local stackSize = capacity.stackSize or 20
  local bagCapacity = bagSlots * stackSize
  -- The planning budget is a cap, never a substitute for cash: a scan that
  -- reports 30k in the purse cannot fund a 94k ladder. Both runtimes feed
  -- the same fields, so the bound belongs here rather than in one caller.
  --
  -- An absent cash field (nil) means the caller does not know the balance;
  -- a reported 0 means the purse is empty. Treating the two as one let a
  -- broke character be sized against the planning budget in the terminal
  -- while the in-game radar, reading GetMoney(), stayed silent.
  local cash = capital.cash
  local requested = capital.budget or 0
  if requested <= 0 then requested = cash or 0 end
  local budget = cash ~= nil and math.min(requested, cash) or requested

  local rows = {}
  local excluded = {
    noBook = 0, thinBook = 0, noHistory = 0, spread = 0, net = 0,
    noDepth = 0, sizing = 0
  }

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
      -- Bids are the only direct demand signal the client exposes. During
      -- ignition they nudge the ranking; they never relax a gate.
      local demandPrior = (item.demandPrior or 1)
        * Core.eventBoost(now, item.itemClass, item.itemSubClass)
      if phase == "ignition" and (item.highestBid or 0) > 0 then
        demandPrior = demandPrior * 1.2
      end

      -- Class 1: vendor arbitrage. The NPC always buys, so no history,
      -- no spread window and no profit floor apply. Budget and bag space
      -- are the only limits.
      if vendorP > minPrice then
        local qty, cost = Core.executableQtySorted(tiers, vendorP, budget, bagCapacity)
        if qty > 0 then
          local net = (vendorP - cost / qty) * qty
          local row = {
            itemId = itemId,
            name = item.name,
            quality = item.quality,
            marketType = marketType,
            vendor = true,
            minPrice = minPrice,
            candidateUnitPrice = cost / qty,
            -- Kept for the allocator: it reprices a reduced quantity from
            -- the cheap end of the same book.
            tiers = tiers,
            candidateQty = qty,
            sellP = vendorP,
            listP = vendorP,
            spreadPercent = (1 - minPrice / vendorP) * 100,
            candidateNet = round(net),
            candidateNetPerUnit = round(vendorP - cost / qty),
            fillProb = 1,
            fillProbLow = 1,
            fillProbHigh = 1,
            fillBasis = "vendor",
            confidence = "high",
            supplyGrowth = 0,
            bidOnly = item.bidOnly or 0,
            highestBid = item.highestBid or 0,
            inferredSoldLow = 0,
            inferredSoldHigh = 0,
            vendorP = vendorP,
            samples = 0,
            demandPrior = demandPrior
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
        local priceCap = unitPriceCap(listP, marketRules)
        local qty, cost, average = Core.executableQtySorted(tiers, priceCap, budget, bagCapacity)
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
          -- The relist joins the queue behind everything at or below its
          -- price that the purchase did not remove. Buying q units takes
          -- them off the book before they are listed again, so the queue
          -- is the depth at that price minus q, not the whole depth. (A
          -- seller listing from the bag leaves the book untouched, so the
          -- chart and the sell plan count the full depth instead.)
          local ahead = math.max(0, quantityAtOrBelow(tiers, listP) - qty)
          -- Only the cheapest eight rungs are persisted. When the listing
          -- price sits above the last visible rung, the unseen deep book may
          -- also be at or below it; counting every unseen unit as ahead is
          -- the conservative reading and stops a truncated top-of-book from
          -- looking like an empty queue.
          if item.tierTruncated and tiers[#tiers] and listP > tiers[#tiers].p then
            ahead = math.max(ahead, (item.quantity or 0) - qty)
          end
          local low, high, point, fillBasis, fillHazard = Core.fillProbability({
            horizonHours = fillHorizonHours(),
            phase = phase,
            marketType = marketType,
            qty = qty,
            ownSold = item.ownSold or 0,
            ownSamples = item.ownSamples or 0,
            ownExposedHours = item.ownExposedHours or 0,
            sold = item.inferredSoldLow or 0,
            supply = item.quantity or 0,
            elapsedHours = item.elapsedHours or scanFloor,
            ahead = ahead,
            -- Observability decides between "nothing disappeared" and "we
            -- could not see": hidden owners make the proxy unobservable.
            observable = Core.isObservable(item)
          })
          local confidence = Core.confidenceFor(samples, sellers, qty, phase)
          -- No fill evidence at all: history depth can still make the trade
          -- actionable, but it cannot make the fill estimate high-confidence.
          if fillBasis == "prior" and confidence == "high" then confidence = "medium" end
          -- The gates and Kelly size the same marginal. A row Kelly refuses
          -- to fund is not an opportunity: excluding it here keeps every
          -- surviving candidate fundable and makes a zero allocation mean
          -- the purse or an exposure cap, never "the risk model said no".
          local sized = Core.sizePosition({
            minPrice = minPrice,
            candidateUnitPrice = average,
            listP = listP,
            sellP = sellP,
            fillProb = point,
            samples = samples
          }, budget, rules)
          if sized.fraction > 0 then
            local row = {
              itemId = itemId,
              name = item.name,
              quality = item.quality,
              marketType = marketType,
              vendor = false,
              minPrice = minPrice,
              candidateUnitPrice = average,
              tiers = tiers,
              candidateQty = qty,
              sellP = sellP,
              listP = listP,
              spreadPercent = spread * 100,
              candidateNet = round(net),
              candidateNetPerUnit = round(net / qty),
              fillProb = point,
              fillProbLow = low,
              fillProbHigh = high,
              fillHazard = fillHazard,
              fillBasis = fillBasis,
              confidence = confidence,
              supplyGrowth = item.supplyGrowth or 0,
              sellerHHI = item.sellerHHI,
              topSellerShare = item.topSellerShare,
              bidOnly = item.bidOnly or 0,
              highestBid = item.highestBid or 0,
              inferredSoldLow = item.inferredSoldLow or 0,
              inferredSoldHigh = item.inferredSoldHigh or 0,
              vendorP = vendorP,
              samples = samples,
              demandPrior = demandPrior
            }
            row.reason = reasonFor(row)
            row.score = scoreFor(phase, row, item.supplyGrowth)
            rows[#rows + 1] = row
          else
            excluded.sizing = excluded.sizing + 1
          end
        end
      end
    end
  end

  table.sort(rows, function(left, right)
    if left.vendor ~= right.vendor then return left.vendor end
    if left.score ~= right.score then return left.score > right.score end
    if left.candidateNet ~= right.candidateNet then return left.candidateNet > right.candidateNet end
    return left.itemId < right.itemId
  end)
  local _, unfunded = Core.allocate(rows, budget, rules)
  -- The funded layer. Every "buy this now" surface reads this list instead
  -- of re-filtering rows with its own copy of `allocQty > 0`.
  local opportunities = {}
  for _, row in ipairs(rows) do
    if (row.allocQty or 0) > 0 then opportunities[#opportunities + 1] = row end
  end
  -- The ladder was only ever the allocator's input: keeping it on every
  -- row would copy books the UIs already render from the scan.
  for _, row in ipairs(rows) do row.tiers = nil end

  -- Conditional plans, not a bare action queue: each buy carries the
  -- abort condition, and each held position carries its sell plan. The
  -- quantity is the allocated one, not the market depth: the actions share
  -- one purse.
  local actions = {}
  local planned = 0
  for _, row in ipairs(opportunities) do
    if planned >= 12 then break end
    planned = planned + 1
    if row.vendor then
      actions[#actions + 1] = {
        kind = "buy",
        itemId = row.itemId,
        name = row.name,
        qty = row.allocQty,
        maxUnitPrice = row.sellP,
        unitPrice = row.allocUnitPrice,
        expectedNet = row.allocNet,
        netPerMinute = row.netPerMinute or 0,
        fillProb = 1,
        fillBasis = "vendor",
        allocQty = row.allocQty,
        allocUnitPrice = row.allocUnitPrice,
        confidence = row.confidence,
        exit = "vendor",
        reason = row.reason
      }
    else
      -- Whole copper, rounded down: paying one copper above the cap already
      -- breaks the unit-profit floor the gate applied.
      local abortPrice = math.floor(unitPriceCap(row.listP, typeRules[row.marketType] or typeRules.item))
      actions[#actions + 1] = {
        kind = "buy",
        itemId = row.itemId,
        name = row.name,
        qty = row.allocQty,
        maxUnitPrice = abortPrice,
        unitPrice = row.allocUnitPrice,
        expectedNet = row.allocNet,
        netPerMinute = row.netPerMinute or 0,
        fillProb = row.fillProb,
        fillBasis = row.fillBasis,
        allocQty = row.allocQty,
        allocUnitPrice = row.allocUnitPrice,
        confidence = row.confidence,
        exit = "auction",
        stop = {
          kind = "abort",
          ifPriceAbove = abortPrice
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
        local expectedNet = round(Core.netIfSold(price, position.qty, position.cost / position.qty, feeRate))
        actions[#actions + 1] = {
          kind = "sell",
          itemId = itemId,
          name = item and item.name,
          qty = position.qty,
          price = price,
          expectedNet = expectedNet,
          -- The sell plan costs a round trip plus the listing, not a buy.
          netPerMinute = round(expectedNet / math.max(effortMinutes("sell"), 1)),
          reason = "持仓卖出计划"
        }
      end
    end
  end

  return {
    phase = phase,
    rows = rows,
    opportunities = opportunities,
    actions = actions,
    -- Why rows fell out of the radar, keyed by gate, and why a candidate
    -- received no copper, keyed by cause. The UIs explain exclusions per
    -- row; the core's own tests read this table.
    diagnostics = { excluded = excluded, unfunded = unfunded }
  }
end

-- Sell-side plan for one item and one batch. The client computes the
-- deposit (it owns the API); this function owns the fee and breakeven
-- arithmetic so the panel and the terminal cannot disagree.
--
-- opts.deposits = { [12] = copper, [24] = copper, [48] = copper } together
-- with opts.hazard/supply/tiers turns the plan into a price x duration
-- search: the listing that maximises expected copper after fees and the
-- risk of losing the deposit. Without those inputs the plan is the plain
-- one-copper undercut at the caller's duration, and every existing caller
-- keeps that behavior.
function Core.sellPlan(item, position, rules, opts)
  local config = rules or (WAH.RULES) or {}
  local feeRate = config.feeRate or 0.05
  local sellP = item.sellP
  if not sellP then return nil end
  local quantity = position.qty or 1
  local unitCost = position.cost and position.cost / quantity or 0
  local deposits = opts and opts.deposits
  local basePrice = Core.listPrice(sellP, item.vendorP, config)
  local deposit = (opts and opts.deposit) or (deposits and deposits[24]) or 0
  local listP = basePrice
  local duration = (opts and opts.duration) or 24
  local fillProb, expectedNet, optimized
  if deposits and opts.hazard and opts.hazard > 0 and opts.supply and opts.supply > 0 then
    local candidates = {}
    local seen = {}
    local vendorFloor = (item.vendorP or 0) + 1
    for _, price in ipairs({
      basePrice,
      math.floor(basePrice * 0.98),
      math.floor(basePrice * 0.95)
    }) do
      if price >= vendorFloor and not seen[price] then
        seen[price] = true
        candidates[#candidates + 1] = price
      end
    end
    local best
    for _, candidate in ipairs(candidates) do
      local ahead = quantityAtOrBelow(opts.tiers, candidate)
      for _, hours in ipairs({ 12, 24, 48 }) do
        local cost = deposits[hours] or 0
        local probability = Core.fillWithin(opts.hazard, opts.supply, ahead, quantity, hours)
        local net = Core.netIfSold(candidate, quantity, unitCost, feeRate)
        -- The deposit comes back on a sale and is lost on expiry, so the
        -- risk term is deposit x P(expire), never deposit on every trade.
        local value = net * probability - cost * (1 - probability)
        if not best or value > best.value then
          best = { value = value, expectedNet = value, price = candidate,
            hours = hours, fillProb = probability, deposit = cost }
        end
      end
    end
    if best then
      listP = best.price
      duration = best.hours
      deposit = best.deposit
      fillProb = best.fillProb
      expectedNet = round(best.expectedNet)
      optimized = true
    end
  end
  -- An expired listing returns the goods, so the loss is the deposit plus
  -- the gap between cost and the guaranteed NPC floor, not the whole cost.
  local residual = (item.vendorP or 0) * quantity
  return {
    itemId = item.itemId,
    quantity = quantity,
    sellP = sellP,
    listP = listP,
    duration = duration,
    optimized = optimized,
    fillProb = fillProb,
    expectedNet = expectedNet,
    unitCost = unitCost,
    deposit = deposit,
    netIfSold = round(Core.netIfSold(listP, quantity, unitCost, feeRate)),
    sellBreakeven = round(Core.sellBreakeven(unitCost, feeRate) or 0),
    expireBreakeven = round(Core.expireBreakeven(unitCost, deposit, quantity, feeRate) or 0),
    lossIfExpired = round(deposit + math.max(0, unitCost * quantity - residual)),
    feeIfSold = round(listP * quantity * feeRate)
  }
end

-- ============================== Search ===============================
--
-- Search is shared semantics, not a UI detail: the in-game box and the
-- terminal table must open the same item for the same query. Each runtime
-- implements these rules; data/search-parity.json pins them together.

-- Every Unicode space the terminal's `\s` recognises. Lua's `%s` is
-- ASCII-only, so without this a query typed with a full-width, thin or
-- no-break space would stay one token in game while the terminal split it.
local UNICODE_SPACES = {
  "\194\160", -- U+00A0 no-break space
  "\225\154\128", -- U+1680 ogham space mark
  "\226\128\128", "\226\128\129", "\226\128\130", "\226\128\131",
  "\226\128\132", "\226\128\133", "\226\128\134", "\226\128\135",
  "\226\128\136", "\226\128\137", "\226\128\138", -- U+2000..U+200A
  "\226\128\168", "\226\128\169", -- U+2028 line, U+2029 paragraph
  "\226\128\175", -- U+202F narrow no-break space
  "\226\129\159", -- U+205F medium mathematical space
  "\227\128\128", -- U+3000 ideographic space
  "\239\187\191" -- U+FEFF zero width no-break space
}

-- "4338" and "item:4338" address an item directly; anything else is a
-- whitespace-tokenised name query.
function Core.parseSearchQuery(raw)
  -- The terminal's parser treats Unicode spaces as separators. A Chinese
  -- IME emits U+3000 (full-width space) and pasted names carry U+00A0
  -- (no-break space); Lua's `%s` is ASCII-only, so both runtimes normalise
  -- the same set of spaces before tokenising.
  local text = raw or ""
  for _, space in ipairs(UNICODE_SPACES) do
    text = text:gsub(space, " ")
  end
  text = text:match("^%s*(.-)%s*$"):lower()
  if text == "" then return nil end
  -- Bare digits only. `tonumber` would also accept hex, exponents and
  -- fractions, which the terminal's /^\d+$/ rejects; "0x10" must search
  -- names in both runtimes, not address item 16 in one of them.
  local id = text:match("^%d+$") and tonumber(text) or tonumber(text:match("^item:(%d+)$"))
  local tokens = {}
  for token in text:gmatch("%S+") do tokens[#tokens + 1] = token end
  return { text = text, id = id, tokens = tokens }
end

-- 4 exact, 3 prefix, 2 every token present, 1 substring. A miss is 0.
-- Internal: rankSearch is the contract, matching the terminal's module.
local function searchScore(name, query)
  if not name or name == "" or not query then return 0 end
  local lower = name:lower()
  if lower == query.text then return 4 end
  if lower:sub(1, #query.text) == query.text then return 3 end
  for _, token in ipairs(query.tokens) do
    if not lower:find(token, 1, true) then return 0 end
  end
  return #query.tokens > 1 and 2 or 1
end

-- Rank candidates by relevance. A candidate is
-- { itemId, name, booked, quantity }; `booked` means the item has a
-- buyable book, and outranks a bid-only observation at the same score.
function Core.rankSearch(candidates, raw)
  local query = Core.parseSearchQuery(raw)
  if not query then return {} end
  local scored = {}
  for _, candidate in ipairs(candidates or {}) do
    local score
    if query.id and tonumber(candidate.itemId) == query.id then
      score = 5
    else
      score = searchScore(candidate.name, query)
    end
    if score > 0 then
      scored[#scored + 1] = { candidate = candidate, score = score }
    end
  end
  table.sort(scored, function(left, right)
    if left.score ~= right.score then return left.score > right.score end
    local a, b = left.candidate, right.candidate
    local aBooked, bBooked = a.booked and true or false, b.booked and true or false
    if aBooked ~= bBooked then return aBooked end
    local aQuantity, bQuantity = a.quantity or 0, b.quantity or 0
    if aQuantity ~= bQuantity then return aQuantity > bQuantity end
    local aLength, bLength = #(a.name or ""), #(b.name or "")
    if aLength ~= bLength then return aLength < bLength end
    return tonumber(a.itemId) < tonumber(b.itemId)
  end)
  local ranked = {}
  for index, entry in ipairs(scored) do ranked[index] = entry.candidate end
  return ranked
end

WAH.Core = Core
