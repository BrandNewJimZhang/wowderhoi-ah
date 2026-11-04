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

local PROCESS_PER_FRAME = 200
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
local scanState = nil -- { itemsById, itemInfoCache, cursor, total, processing, capture }
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
    listings = {}, -- { price = unit price, count, timeLeft }
    flowKeys = {}, -- owner|unitPrice -> quantity, matched across scans
    ownerTotals = {}, -- owner -> quantity across all prices, detects repricing
    flowTimeLeft = {}, -- flow key -> shortest remaining time seen
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
    local cached = scanState.itemInfoCache[itemId]
    if cached == nil then
      -- GetItemInfo is the single most expensive call per new itemId. Read
      -- every field once, cache it for the scan's lifetime, and let repeat
      -- listings reuse the result.
      local _, _, _, _, _, itemClass, itemSubClass, _, _, _, vendorPrice = WAH.getItemInfo(itemId)
      if itemClass == nil and C_Item and C_Item.RequestLoadItemDataByID then
        -- The item database loads lazily on modern clients. Ask once so the
        -- next scan can price vendor arbitrage for this item.
        C_Item.RequestLoadItemDataByID(itemId)
      end
      cached = { class = itemClass, subClass = itemSubClass, vendorP = vendorPrice or 0 }
      scanState.itemInfoCache[itemId] = cached
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
  entry.listings[#entry.listings + 1] = { price = unitPrice, count = count, timeLeft = timeLeft, owner = seller }
  entry.quantity = entry.quantity + count
  entry.numAuctions = entry.numAuctions + 1
  local flowKey = (seller or "?") .. "|" .. unitPrice
  entry.flowKeys[flowKey] = (entry.flowKeys[flowKey] or 0) + count
  if seller then
    entry.ownerTotals[seller] = (entry.ownerTotals[seller] or 0) + count
  end
  if timeLeft then
    local current = entry.flowTimeLeft[flowKey]
    if not current or timeLeft < current then entry.flowTimeLeft[flowKey] = timeLeft end
  end
  entry.expiring[expiryBucket(timeLeft)] = entry.expiring[expiryBucket(timeLeft)] + 1
end

local function aggregateTiers(listings)
  local byPrice = {}
  for _, listing in ipairs(listings) do
    local tier = byPrice[listing.price]
    if not tier then
      tier = { p = listing.price, q = 0 }
      byPrice[listing.price] = tier
    end
    tier.q = tier.q + listing.count
  end
  local tiers = {}
  for _, tier in pairs(byPrice) do tiers[#tiers + 1] = tier end
  table.sort(tiers, function(left, right)
    if left.p == right.p then return left.q < right.q end
    return left.p < right.p
  end)
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
  series.p10[#series.p10 + 1] = item.marketPrice
  series.q[#series.q + 1] = item.quantity
  series.n[#series.n + 1] = item.numAuctions
  series.s[#series.s + 1] = item.sellers
  series.d[#series.d + 1] = item.inferredSoldLow or 0
  series.e[#series.e + 1] = event
end

local function copyPoint(series, source, target)
  target.t[#target.t + 1] = series.t[source]
  target.min[#target.min + 1] = series.min[source]
  target.sell[#target.sell + 1] = series.sell[source]
  target.p10[#target.p10 + 1] = series.p10[source]
  target.q[#target.q + 1] = series.q[source]
  target.n[#target.n + 1] = series.n[source]
  target.s[#target.s + 1] = series.s[source]
  target.d[#target.d + 1] = series.d[source]
  target.e[#target.e + 1] = series.e[source]
end

-- Layered retention: every scan for 24 hours, the last point per hour for
-- a week, the last point per day for a month. Event points (a 10% sell-
-- front move or a 25% supply move) survive the hourly fold.
local function pruneSeries(series, nowTs)
  local cutoff24, cutoff7, cutoff30 = nowTs - DAY, nowTs - 7 * DAY, nowTs - 30 * DAY
  local kept = { t = {}, min = {}, sell = {}, p10 = {}, q = {}, n = {}, s = {}, d = {}, e = {} }
  local lastHour, lastDay
  for index = 1, #series.t do
    local stamp = series.t[index]
    if stamp >= cutoff30 then
      local keep = false
      if stamp >= cutoff24 then
        keep = true
      elseif stamp >= cutoff7 then
        local hour = math.floor(stamp / HOUR)
        if hour ~= lastHour then keep = true; lastHour = hour end
        if series.e[index] == 1 then keep = true end
      else
        local day = math.floor(stamp / DAY)
        if day ~= lastDay then keep = true; lastDay = day end
        if series.e[index] == 1 then keep = true end
      end
      if keep then copyPoint(series, index, kept) end
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
      local trimmed = { t = {}, min = {}, sell = {}, p10 = {}, q = {}, n = {}, s = {}, d = {}, e = {} }
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
        series = { t = {}, min = {}, sell = {}, p10 = {}, q = {}, n = {}, s = {}, d = {}, e = {} }
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
  for key, quantity in pairs(previous.keys or {}) do
    local remaining = entry.flowKeys[key] or 0
    local timeLeft = previous.t and previous.t[key]
    -- A listing cannot have sold if its previous remaining time was shorter
    -- than the gap between scans: that disappearance is an expiry.
    local live = timeLeft and timeLeft > elapsedSeconds + 60
    if quantity > remaining and (not timeLeft or live) then
      high = high + (quantity - remaining)
    end
    if live then
      local owner = key:match("^(.-)|")
      if owner and owner ~= "?" then
        -- Only units that could not have expired contribute to the lower
        -- edge; an owner total that moved between prices stays unchanged.
        liveOwners[owner] = (liveOwners[owner] or 0) + quantity
      end
    end
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
      table.sort(entry.listings, function(left, right) return left.price < right.price end)
      local tiers = aggregateTiers(entry.listings)
      local storedTiers = topTiers(tiers, 8)
      local marketType = Core.marketTypeFor({
        itemClass = entry.itemClass,
        quantity = entry.quantity,
        numAuctions = entry.numAuctions
      })
      local sellP = Core.sellFront(tiers, {
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
        vendorP = entry.vendorP,
        minPrice = math.floor((entry.minPrice or 0) + 0.5),
        sellP = math.floor((sellP or entry.minPrice or 0) + 0.5),
        p5 = math.floor((Core.weightedPercentile(tiers, 0.05) or entry.minPrice or 0) + 0.5),
        marketPrice = math.floor((Core.weightedPercentile(tiers, 0.10) or entry.minPrice or 0) + 0.5),
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
        keys = entry.flowKeys,
        t = entry.flowTimeLeft,
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
    total = totalAuctions or 0,
    items = items
  }
  WoWderhoiAH_Capture = {
    v = WAH.PIPELINE_VERSION,
    at = nowTs,
    market = marketKey(),
    items = captureItems
  }
  recordSeries(items, nowTs)
  scanState = nil
  WAH.scanRunning = false
  scanFailures = 0
  -- Write SavedVariables immediately so the desktop watcher sees this scan
  -- in seconds, not at the next logout. Fall back silently on clients that
  -- do not expose the API.
  if C_AddOns and C_AddOns.SaveAddOns then pcall(C_AddOns.SaveAddOns) end
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
  if index > total then
    frame:SetScript("OnUpdate", nil)
    finishScan(total)
  end
end

local function startProcessing()
  if scanState.processing then return end
  scanState.processing = true
  scanState.cursor = 1
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
    itemInfoCache = {},
    processing = false,
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
function WAH.currentPhase()
  local override = WAH.settings and WAH.settings.phaseOverride
  if override and override ~= "auto" then return override end
  local scan = WoWderhoiAH_ScanData
  if not scan or scan.dataVersion ~= WAH.PIPELINE_VERSION then return "ignition" end
  local breadth = 0
  for _, item in pairs(scan.items or {}) do
    if item.minPrice and item.minPrice > 0 then breadth = breadth + 1 end
  end
  local market = WAH.seriesMarket()
  local firstScanAt = market and market.firstScanAt or scan.scannedAt or time()
  local ageHours = math.max(0, (time() - firstScanAt) / HOUR)
  return Core.phaseFor(ageHours, breadth, WAH.RULES.phaseBoundaries)
end

function WAH.scanAgeMinutes()
  local scan = WoWderhoiAH_ScanData
  if not scan or not scan.scannedAt then return nil end
  return math.max(0, (time() - scan.scannedAt) / 60)
end

-- Single history authority. The decision core reads sellRef/samples; the
-- tooltip and the legacy display read the remaining statistics. med7 is
-- kept as a statistic (P10 median) and must not re-enter a decision.
function WAH.history(itemId, windowHours)
  local market = WAH.seriesMarket()
  local series = market and market.items[itemId]
  if not series or #series.t == 0 then return nil end
  local phase = WAH.currentPhase()
  local phaseRule = WAH.RULES.phaseHistory[phase] or { windowHours = 168 }
  local window = windowHours or phaseRule.windowHours
  if window <= 0 then window = 168 end
  local cutoff = time() - window * HOUR
  local sells, pts = {}, {}
  for index = 1, #series.t do
    if series.t[index] >= cutoff then
      sells[#sells + 1] = series.sell[index]
      pts[#pts + 1] = {
        t = series.t[index],
        c = series.p10[index],
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
      t = series.t[last], c = series.p10[last], sell = series.sell[last],
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

-- Assemble the decision core's input from the latest scan, the retained
-- series, the journal-derived positions and the player's deployable
-- capital. One builder, so the cockpit and the sell page cannot disagree
-- about what the market state is.
function WAH.coreInput()
  local scan = WoWderhoiAH_ScanData
  local market = WAH.seriesMarket()
  local input = {
    now = time(),
    market = {
      scannedAt = scan and scan.scannedAt or nil,
      firstScanAt = market and market.firstScanAt or nil,
      items = {}
    },
    positions = {},
    capital = { cash = 0, mail = 0, escrow = 0, budget = 0 },
    capacity = { bagSlots = 20, stackSize = 20 }
  }
  if not scan or scan.dataVersion ~= WAH.PIPELINE_VERSION then return input end
  local override = WAH.settings and WAH.settings.phaseOverride
  if override and override ~= "auto" then input.phaseOverride = override end
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  local ownWindowDays = (WAH.RULES.fill and WAH.RULES.fill.ownSalesWindowDays) or 7
  local ownSales = ledger and WAH.Ledger.salesSince(ownWindowDays * 24 * 3600, input.now) or {}
  for itemId, entry in pairs(scan.items or {}) do
    if entry.minPrice and entry.minPrice > 0 then
      local history = WAH.history(itemId)
      local own = ownSales[itemId]
      input.market.items[itemId] = {
        itemId = itemId,
        name = entry.name,
        quality = entry.quality,
        itemClass = entry.itemClass,
        itemSubClass = entry.itemSubClass,
        vendorP = entry.vendorP,
        minPrice = entry.minPrice,
        sellP = entry.sellP,
        quantity = entry.quantity,
        numAuctions = entry.numAuctions,
        sellers = entry.sellers,
        sellersInvisible = entry.sellersInvisible,
        bidOnly = entry.bidOnly,
        tiers = entry.tiers,
        inferredSoldLow = entry.inferredSoldLow,
        inferredSoldHigh = entry.inferredSoldHigh,
        supplyGrowth = entry.supplyGrowth,
        elapsedHours = entry.elapsedHours,
        ownSold = own and own.qty or 0,
        ownSamples = own and own.samples or 0,
        ownElapsedHours = own and own.elapsedHours or 0,
        demandPrior = Core.demandFor(entry.itemClass, entry.itemSubClass),
        history = history and { samples = history.samples } or nil
      }
    end
  end
  local cash = GetMoney and GetMoney() or 0
  input.positions = ledger and ledger.positions or {}
  input.capital = {
    cash = cash,
    mail = 0,
    escrow = ledger and ledger.capital and ledger.capital.escrow or 0,
    budget = math.floor(cash * (WAH.RULES.portfolio.dailyBudget or 0.5))
  }
  return input
end
