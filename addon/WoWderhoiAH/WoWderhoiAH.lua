-- WoWderhoiAH scanner for WoW Forever (client 1.60.1).
--
-- A full scan is C_AuctionHouse.ReplicateItems(): one server roundtrip that
-- replicates every listing, commodity and item auction alike. The 1.60
-- client is a modern-API client — QueryAuctionItems / GetAuctionItemInfo /
-- CanSendAuctionQuery do not exist, and there is no paged fallback to fall
-- back to. ReplicateItems is the supported replacement (the client's own
-- docs point an "all items" query at it).
--
-- Pipeline v4 captures what the decision core actually needs:
--   * every field the replicate row carries (bid, owner, sale status,
--     remaining time), not just name/count/buyout/itemId;
--   * a top-8 price ladder per item, so buying N units can be priced;
--   * distinct sellers and expiry buckets, so competition and future
--     supply are visible;
--   * bid-only listings, the only direct demand signal the client exposes;
--   * a tier-level capture table, so an adjacent scan can infer how much
--     disappeared and whether it looked like a sale rather than an expiry.
-- Nothing is inferred into a point estimate: sold quantity is recorded as
-- a bounded interval and every consumer labels it "inferred".

local ADDON_NAME, WAH = ...
local L = WAH.L
local Core = WAH.Core

-- The row count is only a safety cap; FRAME_BUDGET_MS is the real throttle.
-- A low cap makes the scan take more frames without using the budget: on a
-- fast client 200 rows finish well under 8 ms, and the scan then runs
-- several times longer than the work actually needs.
local PROCESS_PER_FRAME = 1000
local FRAME_BUDGET_MS = 8
-- A replicate scan is one server response; if it has not arrived by then,
-- the request was refused or lost. Abort loudly instead of leaving the
-- auto-rescan ticker blocked behind a scan that never finishes.
local SCAN_TIMEOUT_SECONDS = 120
-- Compiled from src/lib/market-rules.ts; the terminal's elapsed-time floor
-- reads the same constant, so the ticker and the fill model stay aligned.
local SCAN_MINUTES = WAH.RULES.scanIntervalMinutes or 15
local AUTO_SCAN_INTERVAL = SCAN_MINUTES * 60
local SEARCH_QUIET_SECONDS = 60
local SERIES_CAP = 60000
local HOUR, DAY = 3600, 86400
-- A gap shorter than one scan interval is a manual rescan: the flow model
-- must not extrapolate a sale rate from it. The terminal importer and the
-- shared core floor at the same compiled value.
local SCAN_FLOOR_HOURS = AUTO_SCAN_INTERVAL / HOUR

local frame -- created below; scanner helpers close over it
local scanState = nil -- { itemsById, cursor, total, processing, processMs, capture }

-- Item metadata resolved once per session, not once per scan. The client's
-- item database loads lazily, so an unresolved lookup is retried next scan
-- instead of caching a nil class and a zero vendor price forever.
local itemInfoCache = {}
local lastScanStartedAt = 0
local scanFailures = 0
local backoffUntil = 0
local searchQuietUntil = 0

-- The auction house frame is named differently across client eras. The 1.60
-- client ships the modern AuctionHouseFrame; the fallback keeps the shared
-- GUI code working if it ever runs on a legacy frame.
function WAH.ahFrame()
  return _G.AuctionHouseFrame or _G.AuctionFrame
end

-- Write SavedVariables now instead of waiting for the next logout, so the
-- desktop watcher sees a finished scan or a collected sale within seconds.
-- A client without the API keeps its usual logout/reload flush.
function WAH.flush()
  if C_AddOns and C_AddOns.SaveAddOns then pcall(C_AddOns.SaveAddOns) end
end

-- The 1.60 client documents item and money lookups under their C_
-- namespaces; the old global aliases are not part of that surface. These
-- two shims are the only places that choose between the two, so a build
-- that keeps the aliases and one that drops them both work.
function WAH.getItemInfo(itemId)
  if C_Item and C_Item.GetItemInfo then return C_Item.GetItemInfo(itemId) end
  return GetItemInfo(itemId)
end

function WAH.coinString(amount)
  if C_CurrencyInfo and C_CurrencyInfo.GetCoinTextureString then
    return C_CurrencyInfo.GetCoinTextureString(amount)
  end
  return GetCoinTextureString(amount)
end

function WAH.itemIcon(itemId)
  if C_Item and C_Item.GetItemIconByID then
    local icon = C_Item.GetItemIconByID(itemId)
    if icon then return icon end
  end
  if GetItemIcon then
    local icon = GetItemIcon(itemId)
    if icon then return icon end
  end
  local _, _, _, _, _, _, _, _, _, texture = WAH.getItemInfo(itemId)
  return texture or "Interface\\Icons\\INV_Misc_QuestionMark"
end

local function chatMessage(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoWderhoiAH|r " .. text)
end

local function autoScanOn()
  return WAH.settings and WAH.settings.autoScan
end

local function marketKey()
  return GetRealmName() .. "|" .. (UnitFactionGroup("player") or "Unknown")
end

-- One definition of "the current scan". The pipeline version gates every
-- reader: a scan written by another pipeline is treated as absent rather
-- than reinterpreted field by field. Callers that must distinguish "no scan
-- yet" from "scan from an old pipeline" inspect the raw global themselves.
function WAH.currentScan()
  local scan = WoWderhoiAH_ScanData
  if type(scan) ~= "table" or scan.dataVersion ~= WAH.PIPELINE_VERSION then return nil end
  return scan
end

function WAH.currentScanItems()
  local scan = WAH.currentScan()
  return scan and scan.items or {}
end

-- ============================ Time left ==============================

-- GetReplicateItemTimeLeft returns either seconds or a coarse band,
-- depending on the client build. Bands 0..4 are mapped to a conservative
-- upper edge; anything larger is already seconds.
local TIME_LEFT_BANDS = { [0] = 1800, [1] = 2 * HOUR, [2] = 12 * HOUR, [3] = 48 * HOUR, [4] = 48 * HOUR }
local function timeLeftSeconds(value)
  if type(value) ~= "number" then return nil end
  if value > 4 then return value end
  return TIME_LEFT_BANDS[value] or 48 * HOUR
end

local function expiryBucket(seconds)
  if not seconds then return "late" end
  if seconds < 2 * HOUR then return "soon" end
  if seconds < 12 * HOUR then return "mid" end
  return "late"
end

-- ============================== Capture ==============================

local function newEntry(name, quality, cached)
  return {
    name = name,
    quality = quality,
    itemClass = cached.class,
    itemSubClass = cached.subClass,
    vendorP = cached.vendorP,
    minPrice = nil,
    tierQuantity = {}, -- unitPrice -> quantity, aggregated as rows arrive
    -- owner ("" when hidden) -> unitPrice -> { q = quantity, t = shortest
    -- remaining time }. Matched across scans to infer disappearances.
    flow = {},
    ownerTotals = {}, -- owner -> quantity across all prices, detects repricing
    bidAmount = 0,
    bidOnly = 0,
    hasBuyout = false,
    sellers = {},
    sellerUnknown = false,
    quantity = 0,
    numAuctions = 0,
    expiring = { soon = 0, mid = 0, late = 0 }
  }
end

local function recordAuction(index)
  -- GetReplicateItemInfo return order: name, texture, count, quality, usable,
  -- level, levelType, minBid, minIncrement, buyoutPrice, bidAmount,
  -- highBidder, bidderFullName, owner, ownerFullName, saleStatus, itemID,
  -- hasAllInfo.
  local name, _, count, quality, _, _, _, _, _, buyoutPrice, bidAmount, _, _,
    owner, ownerFullName, _, itemId = C_AuctionHouse.GetReplicateItemInfo(index)
  if not (itemId and name) then return end
  local seller = owner or ownerFullName
  local timeLeft = C_AuctionHouse.GetReplicateItemTimeLeft
    and timeLeftSeconds(C_AuctionHouse.GetReplicateItemTimeLeft(index)) or nil

  local entry = scanState.itemsById[itemId]
  if not entry then
    local cached = itemInfoCache[itemId]
    if not cached then
      -- GetItemInfo is the single most expensive call per new itemId. Read
      -- every field once, cache it for the session, and let repeat listings
      -- and later scans reuse the result.
      local _, _, _, _, _, itemClass, itemSubClass, _, _, _, vendorPrice = WAH.getItemInfo(itemId)
      cached = { class = itemClass, subClass = itemSubClass, vendorP = vendorPrice or 0 }
      if itemClass ~= nil then
        itemInfoCache[itemId] = cached
      elseif C_Item and C_Item.RequestLoadItemDataByID then
        -- The item database loads lazily on modern clients. Ask once so the
        -- next scan can price vendor arbitrage for this item.
        C_Item.RequestLoadItemDataByID(itemId)
      end
    end
    entry = newEntry(name, quality, cached)
    scanState.itemsById[itemId] = entry
  end

  if seller then
    entry.sellers[seller] = true
  else
    entry.sellerUnknown = true
  end
  if bidAmount and bidAmount > (entry.bidAmount or 0) then entry.bidAmount = bidAmount end

  -- Bid-only listings carry no buyout and cannot be bought out. They are
  -- still the only direct demand signal the client publishes, so they are
  -- counted instead of silently dropped.
  if not (buyoutPrice and buyoutPrice > 0 and count and count > 0) then
    entry.bidOnly = entry.bidOnly + 1
    return
  end

  local unitPrice = buyoutPrice / count
  entry.hasBuyout = true
  if not entry.minPrice or unitPrice < entry.minPrice then entry.minPrice = unitPrice end
  entry.tierQuantity[unitPrice] = (entry.tierQuantity[unitPrice] or 0) + count
  entry.quantity = entry.quantity + count
  entry.numAuctions = entry.numAuctions + 1
  -- A listing's identity across scans is owner + unit price. Grouping by
  -- owner first means the per-row path never builds a key string; it looks
  -- up one table and allocates one small record per new (owner, price) pair.
  local ownerKey = seller or ""
  local ownerFlow = entry.flow[ownerKey]
  if not ownerFlow then
    ownerFlow = {}
    entry.flow[ownerKey] = ownerFlow
  end
  local flow = ownerFlow[unitPrice]
  if flow then
    flow.q = flow.q + count
    if timeLeft and (not flow.t or timeLeft < flow.t) then flow.t = timeLeft end
  else
    ownerFlow[unitPrice] = { q = count, t = timeLeft }
  end
  if seller then
    entry.ownerTotals[seller] = (entry.ownerTotals[seller] or 0) + count
  end
  local bucket = expiryBucket(timeLeft)
  entry.expiring[bucket] = entry.expiring[bucket] + 1
end

-- One pass over the distinct prices the scan already aggregated, sorted
-- once. The result feeds Core.sellFrontSorted / Core.percentileOfSorted
-- directly, so the finish phase never re-copies the book per statistic.
local function aggregateTiers(tierQuantity)
  local tiers = {}
  for price, quantity in pairs(tierQuantity) do
    tiers[#tiers + 1] = { p = price, q = quantity }
  end
  table.sort(tiers, function(left, right) return left.p < right.p end)
  return tiers
end

local function topTiers(tiers, limit)
  local top = {}
  for index = 1, math.min(limit or 8, #tiers) do top[index] = tiers[index] end
  return top
end

local function countSellers(entry)
  local count = 0
  for _ in pairs(entry.sellers) do count = count + 1 end
  return count
end

-- ============================== Series ===============================

local function ensureSeries()
  if type(WoWderhoiAH_Series) ~= "table" or WoWderhoiAH_Series.v ~= WAH.PIPELINE_VERSION then
    WoWderhoiAH_Series = { v = WAH.PIPELINE_VERSION, markets = {} }
  end
  local key = marketKey()
  local market = WoWderhoiAH_Series.markets[key]
  if not market then
    market = { firstScanAt = time(), items = {} }
    WoWderhoiAH_Series.markets[key] = market
  end
  return market
end
WAH.seriesMarket = ensureSeries

local function appendPoint(series, item, nowTs)
  local prevSell = series.sell[#series.sell]
  local prevQ = series.q[#series.q]
  local event = 0
  if prevSell and prevSell > 0 and math.abs(item.sellP - prevSell) / prevSell >= 0.10 then event = 1 end
  if prevQ and prevQ > 0 and math.abs(item.quantity - prevQ) / prevQ >= 0.25 then event = 1 end
  series.t[#series.t + 1] = nowTs
  series.min[#series.min + 1] = item.minPrice
  series.sell[#series.sell + 1] = item.sellP
  series.q[#series.q + 1] = item.quantity
  series.e[#series.e + 1] = event
end

local function copyPoint(series, source, target)
  target.t[#target.t + 1] = series.t[source]
  target.min[#target.min + 1] = series.min[source]
  target.sell[#target.sell + 1] = series.sell[source]
  target.q[#target.q + 1] = series.q[source]
  target.e[#target.e + 1] = series.e[source]
end

-- Drop the last kept point from every array in `kept`.
local function popKept(kept)
  kept.t[#kept.t] = nil
  kept.min[#kept.min] = nil
  kept.sell[#kept.sell] = nil
  kept.q[#kept.q] = nil
  kept.e[#kept.e] = nil
end

-- Layered retention: every scan for 24 hours, the LAST point of each hour
-- for a week, the last point of each day for a month. A close is the
-- statistic the charts and the sell median read, so a folded hour keeps
-- its close rather than its open. Event points (a 10% sell-front move or a
-- 25% supply move) survive the fold in addition to the close.
local function pruneSeries(series, nowTs)
  local cutoff24, cutoff7, cutoff30 = nowTs - DAY, nowTs - 7 * DAY, nowTs - 30 * DAY
  local kept = { t = {}, min = {}, sell = {}, q = {}, e = {} }
  local lastHour, lastDay
  local lastIsEvent = false -- event points are never replaced by a later close
  for index = 1, #series.t do
    local stamp = series.t[index]
    if stamp >= cutoff30 then
      local event = series.e[index] == 1
      if stamp >= cutoff24 then
        copyPoint(series, index, kept)
      elseif stamp >= cutoff7 then
        local hour = math.floor(stamp / HOUR)
        if hour == lastHour and not lastIsEvent then popKept(kept) else lastHour = hour end
        copyPoint(series, index, kept)
        lastIsEvent = event
      else
        local day = math.floor(stamp / DAY)
        if day == lastDay and not lastIsEvent then popKept(kept) else lastDay = day end
        copyPoint(series, index, kept)
        lastIsEvent = event
      end
    end
  end
  return kept
end

local function enforceSeriesCap(market)
  local total, count = 0, 0
  for _, series in pairs(market.items) do
    total = total + #series.t
    count = count + 1
  end
  if total <= SERIES_CAP or count == 0 then return end
  local perItem = math.max(8, math.floor(SERIES_CAP / count))
  for itemId, series in pairs(market.items) do
    if #series.t > perItem then
      local trimmed = { t = {}, min = {}, sell = {}, q = {}, e = {} }
      for index = #series.t - perItem + 1, #series.t do copyPoint(series, index, trimmed) end
      market.items[itemId] = trimmed
    end
  end
end

local function recordSeries(items, nowTs)
  local market = ensureSeries()
  market.firstScanAt = math.min(market.firstScanAt or nowTs, nowTs)
  for itemId, item in pairs(items) do
    -- Demand-only rows carry no price; keeping their zeros in the series
    -- would drag every sell-median and chart toward 0.
    if item.minPrice and item.minPrice > 0 then
      local series = market.items[itemId]
      if not series then
        series = { t = {}, min = {}, sell = {}, q = {}, e = {} }
        market.items[itemId] = series
      end
      appendPoint(series, item, nowTs)
      market.items[itemId] = pruneSeries(series, nowTs)
    end
  end
  -- Drop items whose series was pruned to nothing.
  for itemId, series in pairs(market.items) do
    if #series.t == 0 then market.items[itemId] = nil end
  end
  enforceSeriesCap(market)
end

-- ============================== Finish ===============================

local function previousCapture()
  local capture = WoWderhoiAH_Capture
  if type(capture) ~= "table" or capture.v ~= WAH.PIPELINE_VERSION then return nil end
  -- Captures written before the owner-keyed shape carry flat "owner|price"
  -- strings. They cannot be matched, so the first scan after the upgrade
  -- starts a fresh baseline instead of crashing on a string.
  if capture.shape ~= "owner-price" then return nil end
  if capture.market ~= marketKey() then return nil end
  return capture
end

-- Disappearances between two scans, as an interval.
--
--   high  units that left their (owner, unitPrice) key and were not
--         expiring. Includes sales, cancellations and repricing.
--   low   units that left an owner entirely. A price change keeps the
--         owner's total, so repricing is excluded; cancellations remain.
--         Never above high.
--
-- Without visible owners the lower edge is zero: every disappearance could
-- be a reprice. The core therefore falls back to its phase prior instead of
-- pretending the upper edge is demand.
local function inferFlow(entry, previous, elapsedSeconds)
  if not previous or elapsedSeconds <= 0 then return 0, 0, 0 end
  local high = 0
  local liveOwners = {}
  for owner, prices in pairs(previous.keys or {}) do
    local nowByPrice = entry.flow[owner]
    local liveQuantity = 0
    for price, was in pairs(prices) do
      local now = nowByPrice and nowByPrice[price]
      local remaining = now and now.q or 0
      -- A listing cannot have sold if its previous remaining time was shorter
      -- than the gap between scans: that disappearance is an expiry.
      local live = was.t and was.t > elapsedSeconds + 60
      if was.q > remaining and (not was.t or live) then
        high = high + (was.q - remaining)
      end
      -- Only units that could not have expired contribute to the lower
      -- edge; an owner total that moved between prices stays unchanged.
      if live then liveQuantity = liveQuantity + was.q end
    end
    if liveQuantity > 0 and owner ~= "" then liveOwners[owner] = liveQuantity end
  end
  local low = 0
  for owner, quantity in pairs(liveOwners) do
    local remaining = entry.ownerTotals[owner] or 0
    if quantity > remaining then low = low + (quantity - remaining) end
  end
  low = math.min(low, high)
  local elapsedHours = math.max(elapsedSeconds / HOUR, SCAN_FLOOR_HOURS)
  local supplyGrowth = 0
  if previous.total and previous.total > 0 then
    -- Use the lower edge: assuming fewer sales can only overstate new supply,
    -- which is the conservative direction for a bubble warning.
    supplyGrowth = ((entry.quantity - previous.total) + low) / (previous.total * elapsedHours)
  end
  return low, high, supplyGrowth
end

local function finishScan(totalAuctions)
  local finishStart = debugprofilestop()
  local processMs = scanState.processMs or 0
  local waitMs = scanState.waitMs or 0
  local nowTs = time()
  local market = ensureSeries()
  local phase = WAH.currentPhase and WAH.currentPhase() or "steady"
  local items = {}
  local itemCount = 0
  local previous = scanState.capture
  local elapsedSeconds = previous and (nowTs - (previous.at or nowTs)) or 0
  local captureItems = {}

  for itemId, entry in pairs(scanState.itemsById) do
    itemCount = itemCount + 1
    if entry.hasBuyout then
      local tiers = aggregateTiers(entry.tierQuantity)
      local storedTiers = topTiers(tiers, 8)
      local marketType = Core.marketTypeFor({
        itemClass = entry.itemClass,
        quantity = entry.quantity,
        numAuctions = entry.numAuctions
      })
      local sellP = Core.sellFrontSorted(tiers, {
        rules = WAH.RULES.sellFront,
        byCount = marketType == "item",
        early = phase == "ignition"
      })
      local sellers = countSellers(entry)
      local sellersInvisible = entry.sellerUnknown
      if sellersInvisible then sellers = entry.numAuctions end
      local soldLow, soldHigh, supplyGrowth = inferFlow(entry, previous and previous.items[itemId], elapsedSeconds)
      items[itemId] = {
        name = entry.name,
        quality = entry.quality,
        itemClass = entry.itemClass,
        itemSubClass = entry.itemSubClass,
        marketType = marketType,
        vendorP = entry.vendorP,
        minPrice = math.floor((entry.minPrice or 0) + 0.5),
        sellP = math.floor((sellP or entry.minPrice or 0) + 0.5),
        p5 = math.floor((Core.percentileOfSorted(tiers, 0.05) or entry.minPrice or 0) + 0.5),
        marketPrice = math.floor((Core.percentileOfSorted(tiers, 0.10) or entry.minPrice or 0) + 0.5),
        quantity = entry.quantity,
        numAuctions = entry.numAuctions,
        sellers = sellers,
        sellersInvisible = sellersInvisible,
        bidOnly = entry.bidOnly,
        highestBid = math.floor((entry.bidAmount or 0) + 0.5),
        tiers = storedTiers,
        expiring = entry.expiring,
        inferredSoldLow = soldLow,
        inferredSoldHigh = soldHigh,
        supplyGrowth = supplyGrowth,
        elapsedHours = math.max(elapsedSeconds / HOUR, SCAN_FLOOR_HOURS)
      }
      captureItems[itemId] = {
        keys = entry.flow,
        total = entry.quantity
      }
    elseif entry.bidOnly > 0 then
      items[itemId] = {
        name = entry.name,
        quality = entry.quality,
        itemClass = entry.itemClass,
        itemSubClass = entry.itemSubClass,
        vendorP = entry.vendorP,
        minPrice = 0,
        sellP = 0,
        quantity = 0,
        numAuctions = 0,
        sellers = 0,
        sellersInvisible = entry.sellerUnknown,
        bidOnly = entry.bidOnly,
        highestBid = math.floor((entry.bidAmount or 0) + 0.5),
        tiers = {},
        expiring = entry.expiring,
        inferredSoldLow = 0,
        inferredSoldHigh = 0,
        supplyGrowth = 0
      }
    end
  end

  -- A pipeline bump redefines every field, so old data is discarded rather
  -- than reinterpreted. The first v4 scan is also the first series point.
  local previousVersion = WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.dataVersion
  if previousVersion and previousVersion ~= WAH.PIPELINE_VERSION then
    WoWderhoiAH_Series = nil
    WoWderhoiAH_Capture = nil
  end

  WoWderhoiAH_ScanData = {
    dataVersion = WAH.PIPELINE_VERSION,
    scannedAt = nowTs,
    server = GetRealmName(),
    faction = UnitFactionGroup("player"),
    character = UnitName and UnitName("player") or nil,
    cash = GetMoney and GetMoney() or 0,
    -- Epoch of the server's opening time; 0 means "not set". Always sent so
    -- /wahopen auto can clear the anchor the terminal kept; without it the
    -- terminal would fall back to the earliest scan, which a fresh install
    -- resets to "just opened".
    openedAt = (WAH.settings and WAH.settings.serverOpenedAt) or 0,
    total = totalAuctions or 0,
    items = items
  }
  WoWderhoiAH_Capture = {
    v = WAH.PIPELINE_VERSION,
    shape = "owner-price",
    at = nowTs,
    market = marketKey(),
    items = captureItems
  }
  recordSeries(items, nowTs)
  scanState = nil
  WAH.scanRunning = false
  scanFailures = 0
  local finishMs = debugprofilestop() - finishStart
  -- Write SavedVariables immediately so the desktop watcher sees this scan
  -- in seconds, not at the next logout. Fall back silently on clients that
  -- do not expose the API.
  local saveStart = debugprofilestop()
  WAH.flush()
  -- Where the time went. /wahdiag prints this; without it a "slow scan"
  -- report cannot be told apart from a slow server response.
  WAH.lastScanStats = {
    rows = totalAuctions or 0,
    waitMs = waitMs,
    processMs = processMs,
    finishMs = finishMs,
    saveMs = debugprofilestop() - saveStart
  }
  chatMessage(string.format(
    L.SCAN_COMPLETE .. "%s",
    totalAuctions or 0, itemCount,
    autoScanOn() and string.format(L.SCAN_AUTO_ARMED, SCAN_MINUTES) or ""))
end

local function processReplicateChunk()
  if not scanState then return end
  local total = scanState.total or 0
  local index = scanState.cursor or 1
  local frameStart = debugprofilestop()
  local processed = 0
  -- The cursor always points at the next unprocessed row. Advancing before
  -- the budget check is what keeps a budget break from skipping the row it
  -- stopped on — the old getAll loop advanced after the check and dropped
  -- every item at a fixed-interval boundary.
  while index <= total and processed < PROCESS_PER_FRAME do
    recordAuction(index)
    index = index + 1
    processed = processed + 1
    if debugprofilestop() - frameStart >= FRAME_BUDGET_MS then break end
  end
  scanState.cursor = index
  scanState.processMs = (scanState.processMs or 0) + (debugprofilestop() - frameStart)
  if index > total then
    frame:SetScript("OnUpdate", nil)
    finishScan(total)
  end
end

local function startProcessing()
  if scanState.processing then return end
  scanState.processing = true
  scanState.cursor = 1
  -- Time spent waiting for the server, kept apart from the time spent
  -- processing it: only one of the two is ours.
  scanState.waitMs = debugprofilestop() - (scanState.requestAt or debugprofilestop())
  chatMessage(string.format(L.SCAN_RECEIVED, scanState.total))
  frame:SetScript("OnUpdate", processReplicateChunk)
end

local function ahIsOpen()
  if WAH.ahOpen then return true end
  local auctionHouse = WAH.ahFrame()
  return auctionHouse ~= nil and auctionHouse:IsShown()
end

local function startScan()
  if not ahIsOpen() then
    chatMessage(L.SCAN_OPEN_AH_FIRST)
    return
  end
  if scanState then
    chatMessage(L.SCAN_ALREADY_RUNNING)
    return
  end
  scanState = {
    itemsById = {},
    processing = false,
    processMs = 0,
    requestAt = debugprofilestop(),
    capture = previousCapture()
  }
  WAH.scanRunning = true
  lastScanStartedAt = time()
  chatMessage(L.SCAN_GETALL_START)
  local generation = scanState
  C_AuctionHouse.ReplicateItems()
  C_Timer.After(SCAN_TIMEOUT_SECONDS, function()
    if scanState ~= generation then return end
    frame:SetScript("OnUpdate", nil)
    scanState = nil
    WAH.scanRunning = false
    scanFailures = scanFailures + 1
    -- Exponential backoff: a refused or lost replicate should not be
    -- retried on the same 15-minute cadence that caused it.
    backoffUntil = time() + math.min(120 * scanFailures, 600)
    chatMessage(L.SCAN_TIMEOUT)
  end)
end

frame = CreateFrame("Frame")
-- ReplicateItems publishes through the browse-result signals; item searches
-- publish through NEW_RESULTS_RECEIVED. Both are registered because the
-- client's exact signal depends on which query populated the results.
frame:RegisterEvent("AUCTION_HOUSE_SHOW")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_ADDED")
frame:RegisterEvent("AUCTION_HOUSE_NEW_RESULTS_RECEIVED")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")

local function markPlayerSearch()
  searchQuietUntil = time() + SEARCH_QUIET_SECONDS
end

frame:SetScript("OnEvent", function(_, event, payload)
  if event == "AUCTION_HOUSE_SHOW" then
    WAH.ahOpen = true
    return
  end
  if event == "AUCTION_HOUSE_CLOSED" then
    WAH.ahOpen = false
    if scanState then
      frame:SetScript("OnUpdate", nil)
      scanState = nil
      WAH.scanRunning = false
      chatMessage(L.SCAN_ABORTED)
    end
    return
  end
  -- A NEW_RESULTS_RECEIVED with an itemKey belongs to an item search. Let
  -- it through only as a "the player is using the AH" signal; the scan
  -- itself only accepts the nil-payload form.
  if event == "AUCTION_HOUSE_NEW_RESULTS_RECEIVED" and payload ~= nil then
    markPlayerSearch()
    return
  end
  if not scanState or scanState.processing then return end
  -- A browse signal can fire before the replicate response arrives, and an
  -- unrelated browse can fire it later. Only a non-zero replicate count
  -- proves the response we are waiting for landed.
  if not scanState.total then
    local total = C_AuctionHouse.GetNumReplicateItems()
    if not total or total == 0 then return end
    scanState.total = total
    startProcessing()
  end
end)

-- Auto-rescan: while the AH stays open, replicate again once the scan
-- interval elapses. Player searches pause the ticker so an automatic copy
-- never overwrites the results the player is reading.
C_Timer.NewTicker(20, function()
  if not autoScanOn() or scanState then return end
  if not ahIsOpen() then return end
  if time() < backoffUntil then return end
  if time() < searchQuietUntil then return end
  if time() - lastScanStartedAt < AUTO_SCAN_INTERVAL then return end
  chatMessage(string.format(L.AUTO_TRIGGER, SCAN_MINUTES))
  startScan()
end)

-- ============================== History ==============================

-- The phase is derived from data age and market breadth, never the
-- calendar. A manual override is available for the first hours after a
-- server opens, when breadth lags behind reality.
--
-- Breadth costs one pass over the whole scan, and WAH.history asks for the
-- phase per item -- so recomputing it inside a radar refresh made the
-- refresh quadratic in the number of items. The answer only moves at the
-- phase boundaries (hours) or when the scan or the override changes, so a
-- few seconds of memoization is free.
local phaseCache = { scan = nil, override = nil, openedAt = nil, at = nil, value = nil }
local PHASE_CACHE_SECONDS = 5

function WAH.currentPhase()
  local override = WAH.settings and WAH.settings.phaseOverride
  if override and override ~= "auto" then return override end
  local scan = WAH.currentScan()
  if not scan then return "ignition" end
  local now = time()
  local openedAt = WAH.settings and WAH.settings.serverOpenedAt or 0
  if phaseCache.scan == scan and phaseCache.override == override
    and phaseCache.openedAt == openedAt
    and phaseCache.at and now - phaseCache.at < PHASE_CACHE_SECONDS then
    return phaseCache.value
  end
  local breadth = 0
  for _, item in pairs(scan.items or {}) do
    if item.minPrice and item.minPrice > 0 then breadth = breadth + 1 end
  end
  local market = WAH.seriesMarket()
  -- A configured opening time beats local history: reinstalling the addon
  -- or clearing SavedVariables must not turn a mature market back into
  -- ignition, whose gates are the loosest.
  local anchor = openedAt > 0 and openedAt or (market and market.firstScanAt) or scan.scannedAt or now
  local ageHours = math.max(0, (now - anchor) / HOUR)
  local value = Core.phaseFor(ageHours, breadth, WAH.RULES.phaseBoundaries)
  phaseCache = { scan = scan, override = override, openedAt = openedAt, at = now, value = value }
  return value
end

function WAH.scanAgeMinutes()
  local scan = WAH.currentScan()
  if not scan or not scan.scannedAt then return nil end
  return math.max(0, (time() - scan.scannedAt) / 60)
end

-- One definition of "the sample window". The chart asks for explicit
-- windows; the decision core asks for the phase's. Ignition has no window
-- of its own, so trend and chart statistics borrow the steady window from
-- the same compiled table instead of restating the number.
local function historyWindowHours()
  local phase = WAH.currentPhase()
  local phaseRule = WAH.RULES.phaseHistory[phase]
  local window = phaseRule and phaseRule.windowHours or 0
  if window <= 0 then window = WAH.RULES.phaseHistory.steady.windowHours end
  return window
end

-- Sample count only. The decision core never reads point tables, so a
-- radar refresh must not build one table per history point per item.
function WAH.historySamples(itemId)
  local market = WAH.seriesMarket()
  local series = market and market.items[itemId]
  if not series or #series.t == 0 then return 0 end
  local cutoff = time() - historyWindowHours() * HOUR
  local count = 0
  for index = 1, #series.t do
    if series.t[index] >= cutoff then count = count + 1 end
  end
  -- An item whose retained points all predate the window still has one
  -- usable sample: its latest point, matching WAH.history.
  return count > 0 and count or 1
end

-- Single history authority. The decision core reads samples; the tooltip
-- and charts read sellRef/latest/min/max. P10 stays on the scan snapshot
-- as a statistic and must not re-enter a decision.
function WAH.history(itemId, windowHours)
  local market = WAH.seriesMarket()
  local series = market and market.items[itemId]
  if not series or #series.t == 0 then return nil end
  local window = windowHours or historyWindowHours()
  if window <= 0 then window = WAH.RULES.phaseHistory.steady.windowHours end
  local cutoff = time() - window * HOUR
  local sells, pts = {}, {}
  for index = 1, #series.t do
    if series.t[index] >= cutoff then
      sells[#sells + 1] = series.sell[index]
      pts[#pts + 1] = {
        t = series.t[index],
        sell = series.sell[index],
        min = series.min[index],
        q = series.q[index],
        event = series.e[index]
      }
    end
  end
  if #sells == 0 then
    local last = #series.t
    sells[1] = series.sell[last]
    pts[1] = {
      t = series.t[last], sell = series.sell[last],
      min = series.min[last], q = series.q[last], event = series.e[last]
    }
  end
  local minSell, maxSell = math.huge, 0
  for _, value in ipairs(sells) do
    if value < minSell then minSell = value end
    if value > maxSell then maxSell = value end
  end
  return {
    pts = pts,
    samples = #sells,
    sellRef = Core.median(sells),
    latest = sells[#sells],
    minSell = minSell,
    maxSell = maxSell,
    windowHours = window
  }
end

-- ============================== Commands =============================

SLASH_WOWDERHOIAH1 = "/wahscan"
SlashCmdList["WOWDERHOIAH"] = startScan
WAH.startScan = startScan

SLASH_WOWDERHOIAHAUTO1 = "/wahauto"
SlashCmdList["WOWDERHOIAHAUTO"] = function()
  WAH.settings.autoScan = not WAH.settings.autoScan
  chatMessage(WAH.settings.autoScan and string.format(L.AUTO_ON, SCAN_MINUTES) or L.AUTO_OFF)
end

SLASH_WOWDERHOIAHPHASE1 = "/wahphase"
SlashCmdList["WOWDERHOIAHPHASE"] = function(input)
  local choice = (input or ""):lower()
  if choice == "" then
    chatMessage(string.format(L.PHASE_CURRENT, WAH.currentPhase(), WAH.settings.phaseOverride or "auto"))
    return
  end
  local valid = { ignition = true, wave = true, settle = true, steady = true, auto = true }
  if not valid[choice] then
    chatMessage(L.PHASE_USAGE)
    return
  end
  WAH.settings.phaseOverride = choice
  chatMessage(string.format(L.PHASE_SET, choice))
end

-- Server opening anchor. The client has no string-to-epoch parser, so the
-- accepted forms are explicit: "now", an epoch, or "-N" for N hours ago.
local function setOpenedAt(input)
  local value = (input or ""):match("^%s*(.-)%s*$")
  local openedAt
  if value == "" or value == "auto" then
    openedAt = 0
  elseif value == "now" then
    openedAt = time()
  elseif value:match("^%-%d+$") then
    openedAt = time() - tonumber(value:sub(2)) * HOUR
  elseif value:match("^%d+$") then
    openedAt = tonumber(value)
  else
    chatMessage(L.OPEN_USAGE)
    return
  end
  WAH.settings.serverOpenedAt = openedAt
  if openedAt > 0 then
    chatMessage(string.format(L.OPEN_SET, date("%Y-%m-%d %H:%M", openedAt)))
  else
    chatMessage(L.OPEN_CLEARED)
  end
end

SLASH_WOWDERHOIAHOPEN1 = "/wahopen"
SlashCmdList["WOWDERHOIAHOPEN"] = setOpenedAt

-- Capture rollback levers. Both collectors read these switches; the options
-- panel only carries display settings, so the switches need a command --
-- a lever the player cannot reach is not a rollback path.
local function setCapture(input)
  local target, state = (input or ""):lower():match("^%s*(%S+)%s*(%S*)%s*$")
  if target ~= "mail" and target ~= "craft" then
    chatMessage(L.CAPTURE_USAGE)
    return
  end
  if state ~= "" and state ~= "on" and state ~= "off" then
    chatMessage(L.CAPTURE_USAGE)
    return
  end
  local enabled = state ~= "off"
  if target == "mail" then
    WAH.settings.mailCapture = enabled
  else
    WAH.settings.craftCapture = enabled
  end
  chatMessage(string.format(L.CAPTURE_SET, target, enabled and "on" or "off"))
end

SLASH_WOWDERHOIAHCAPTURE1 = "/wahcapture"
SlashCmdList["WOWDERHOIAHCAPTURE"] = setCapture

-- Free bag slots across the backpack and the four equipped bags. The
-- aggregate is the executable-quantity ceiling; stackSize x slots is an
-- upper bound when a purchase mixes stack sizes, which is the intended
-- conservative direction (never overstate what fits).
local function freeBagSlots()
  if not (C_Container and C_Container.GetContainerNumFreeSlots) then return 20 end
  local total = 0
  for bag = 0, 4 do
    total = total + (C_Container.GetContainerNumFreeSlots(bag) or 0)
  end
  return total
end

-- Assemble the decision core's input from the latest scan, the retained
-- series, the journal-derived positions and the player's deployable
-- capital. One builder, so the cockpit and the sell page cannot disagree
-- about what the market state is.
function WAH.coreInput()
  local scan = WAH.currentScan()
  local market = WAH.seriesMarket()
  local input = {
    now = time(),
    market = {
      firstScanAt = market and market.firstScanAt or nil,
      items = {}
    },
    positions = {},
    capital = { cash = 0, budget = 0 },
    capacity = { bagSlots = freeBagSlots(), stackSize = 20 }
  }
  if not scan then return input end
  -- The phase is whatever WAH.currentPhase resolves -- manual override,
  -- the /wahopen anchor, or the series age. Passing it keeps the radar's
  -- gates on the same phase the status line names; letting the core re-derive
  -- from firstScanAt would ignore a configured opening time and run ignition
  -- gates (the loosest) on a mature market.
  input.phaseOverride = WAH.currentPhase()
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  local ownWindowDays = (WAH.RULES.fill and WAH.RULES.fill.ownSalesWindowDays) or 7
  local ownSales = ledger and WAH.Ledger.salesSince(ownWindowDays * 24 * 3600, input.now) or {}
  for itemId, entry in pairs(scan.items or {}) do
    if entry.minPrice and entry.minPrice > 0 then
      local samples = WAH.historySamples(itemId)
      local own = ownSales[itemId]
      input.market.items[itemId] = {
        itemId = itemId,
        name = entry.name,
        quality = entry.quality,
        itemClass = entry.itemClass,
        -- The scan's classification, not a re-derivation from a book that
        -- purchases have already thinned.
        marketType = entry.marketType,
        vendorP = entry.vendorP,
        minPrice = entry.minPrice,
        sellP = entry.sellP,
        quantity = entry.quantity,
        numAuctions = entry.numAuctions,
        sellers = entry.sellers,
        sellersInvisible = entry.sellersInvisible,
        bidOnly = entry.bidOnly,
        highestBid = entry.highestBid,
        tiers = entry.tiers,
        inferredSoldLow = entry.inferredSoldLow,
        inferredSoldHigh = entry.inferredSoldHigh,
        supplyGrowth = entry.supplyGrowth,
        elapsedHours = entry.elapsedHours,
        ownSold = own and own.qty or 0,
        ownSamples = own and own.samples or 0,
        ownExposedHours = own and own.exposedHours or 0,
        demandPrior = Core.demandFor(entry.itemClass, entry.itemSubClass),
        history = samples > 0 and { samples = samples } or nil
      }
    end
  end
  local cash = GetMoney and GetMoney() or 0
  input.positions = ledger and ledger.positions or {}
  input.capital = {
    cash = cash,
    -- The planning cap is the purse. Core.allocate applies
    -- portfolio.dailyBudget once; discounting it here applied it twice and
    -- gave the game half the spend the terminal grants on the same cash.
    budget = cash
  }
  return input
end
