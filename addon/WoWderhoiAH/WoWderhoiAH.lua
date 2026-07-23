-- WoWderhoiAH Scanner: grabs the auction house list and aggregates
-- per-item min/weighted prices into the WoWderhoiAH_ScanData SavedVariable.
-- Fast path is a getAll query (one server roundtrip for the whole AH,
-- 15-minute server cooldown); on cooldown it falls back to paged
-- scanning gated on the regular per-page throttle.

local PAGE_SIZE = 50
local QUALITY_ANY = -1
local PROCESS_PER_FRAME = 500

local ADDON_NAME, WAH = ...
local L = WAH.L

local scanState = nil -- { mode = "getall"|"paged", page, itemsById, processing, cursor }

local function autoScanOn()
  return WAH.settings and WAH.settings.autoScan
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("AUCTION_ITEM_LIST_UPDATE")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")

local function chatMessage(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoWderhoiAH|r " .. text)
end

local function recordAuction(index)
  local name, _, count, quality, _, _, _, _, _, buyoutPrice = GetAuctionItemInfo("list", index)
  local link = GetAuctionItemLink("list", index)
  local itemId = link and tonumber(link:match("item:(%d+)"))
  if not (itemId and name and buyoutPrice and buyoutPrice > 0 and count and count > 0) then return end
  local unitPrice = buyoutPrice / count
  local entry = scanState.itemsById[itemId]
  if not entry then
    local _, _, _, _, _, itemClass, itemSubClass = GetItemInfo(itemId)
    local vendorPrice = select(11, GetItemInfo(itemId))
    entry = {
      name = name,
      quality = quality,
      itemClass = itemClass,
      itemSubClass = itemSubClass,
      vendorP = vendorPrice or 0,
      minPrice = unitPrice,
      listings = {}, -- { price = unit price, count } for the weighted median
      quantity = 0,
      numAuctions = 0
    }
    scanState.itemsById[itemId] = entry
  end
  if unitPrice < entry.minPrice then entry.minPrice = unitPrice end
  entry.listings[#entry.listings + 1] = { price = unitPrice, count = count }
  entry.quantity = entry.quantity + count
  entry.numAuctions = entry.numAuctions + 1
end

-- Quantity-weighted percentile: the unit price at which `fraction` of
-- the listed quantity sits at or below. P50 is the market price; the
-- P10/P25 rungs show where the cheap tail actually starts. Percentiles
-- shrug off bait stacks that wreck any mean.
local function weightedPercentile(sortedListings, totalQuantity, fraction)
  local threshold = totalQuantity * fraction
  local cumulative = 0
  for _, listing in ipairs(sortedListings) do
    cumulative = cumulative + listing.count
    if cumulative >= threshold then return listing.price end
  end
  return sortedListings[#sortedListings].price
end

-- Depth-aware sell front: the cheapest price with real quantity behind
-- it. Lone dump listings ahead of it sell out in minutes; undercutting
-- them gives gold away. Threshold: 3% of listed supply, at least 3 units.
local function sellFrontPrice(sortedListings, totalQuantity)
  local threshold = math.max(totalQuantity * 0.03, 3)
  local cumulative = 0
  for _, listing in ipairs(sortedListings) do
    cumulative = cumulative + listing.count
    if cumulative >= threshold then return listing.price end
  end
  return sortedListings[#sortedListings].price
end

local function finishScan(totalAuctions)
  local items = {}
  local itemCount = 0
  for itemId, entry in pairs(scanState.itemsById) do
    table.sort(entry.listings, function(left, right) return left.price < right.price end)
    items[itemId] = {
      name = entry.name,
      quality = entry.quality,
      itemClass = entry.itemClass,
      itemSubClass = entry.itemSubClass,
      minPrice = math.floor(entry.minPrice + 0.5),
      vendorP = entry.vendorP,
      sellP = math.floor(sellFrontPrice(entry.listings, entry.quantity) + 0.5),
      p10 = math.floor(weightedPercentile(entry.listings, entry.quantity, 0.10) + 0.5),
      p25 = math.floor(weightedPercentile(entry.listings, entry.quantity, 0.25) + 0.5),
      marketPrice = math.floor(weightedPercentile(entry.listings, entry.quantity, 0.50) + 0.5),
      quantity = entry.quantity,
      numAuctions = entry.numAuctions
    }
    itemCount = itemCount + 1
  end
  WoWderhoiAH_ScanData = {
    dataVersion = 2, -- percentile pricing pipeline; consumers reject anything else
    scannedAt = time(),
    server = GetRealmName(),
    faction = UnitFactionGroup("player"),
    items = items
  }
  -- Accumulate per-item price points in game: c = P50 feeds the 7d
  -- median and deal radar, p = P10 feeds the chart (the cheap-tail
  -- front a buyer actually pays). 7-day window, newest 192 points per
  -- item (~48 h at the 15-minute auto-scan cadence).
  WoWderhoiAH_Points = WoWderhoiAH_Points or {}
  local nowTs = time()
  local cutoff = nowTs - 7 * 24 * 3600
  for itemId, item in pairs(items) do
    local pts = WoWderhoiAH_Points[itemId] or {}
    pts[#pts + 1] = { t = nowTs, c = item.marketPrice, p = item.p10 }
    WoWderhoiAH_Points[itemId] = pts
  end
  for itemId, pts in pairs(WoWderhoiAH_Points) do
    local pruned = {}
    for _, point in ipairs(pts) do
      if point.t >= cutoff then pruned[#pruned + 1] = point end
    end
    while #pruned > 192 do table.remove(pruned, 1) end
    if #pruned == 0 then
      WoWderhoiAH_Points[itemId] = nil
    else
      WoWderhoiAH_Points[itemId] = pruned
    end
  end
  scanState = nil
  WAH.scanRunning = false
  chatMessage(string.format(
    L.SCAN_COMPLETE .. "%s",
    totalAuctions or 0, itemCount, autoScanOn() and L.SCAN_AUTO_ARMED or ""))
end

local function processGetAllChunk()
  local total = GetNumAuctionItems("list")
  local cursor = scanState.cursor
  local target = math.min(cursor + PROCESS_PER_FRAME - 1, total)
  for index = cursor, target do recordAuction(index) end
  scanState.cursor = target + 1
  if target >= total then
    frame:SetScript("OnUpdate", nil)
    finishScan(total)
  end
end

local function queryCurrentPage()
  if not scanState or scanState.mode ~= "paged" then return end
  -- First return value is the regular per-page throttle (sub-second),
  -- NOT select(2,...) which is the 15-minute getAll cooldown.
  if not CanSendAuctionQuery() then
    C_Timer.After(0.2, queryCurrentPage)
    return
  end
  QueryAuctionItems("", nil, nil, scanState.page, false, QUALITY_ANY, false, false)
end

local function startScan()
  if not AuctionFrame or not AuctionFrame:IsShown() then
    chatMessage(L.SCAN_OPEN_AH_FIRST)
    return
  end
  if scanState then
    chatMessage(L.SCAN_ALREADY_RUNNING)
    return
  end
  WAH.scanRunning = true
  local _, canGetAll = CanSendAuctionQuery()
  if canGetAll then
    scanState = { mode = "getall", itemsById = {} }
    chatMessage(L.SCAN_GETALL_START)
    QueryAuctionItems("", nil, nil, 0, false, QUALITY_ANY, true, false)
  else
    scanState = { mode = "paged", page = 0, itemsById = {} }
    chatMessage(L.SCAN_PAGED_START)
    queryCurrentPage()
  end
end

frame:SetScript("OnEvent", function(_, event)
  if event == "AUCTION_HOUSE_CLOSED" then
    if scanState then
      frame:SetScript("OnUpdate", nil)
      scanState = nil
      WAH.scanRunning = false
      chatMessage(L.SCAN_ABORTED)
    end
    return
  end
  -- AUCTION_ITEM_LIST_UPDATE
  if not scanState then return end
  if scanState.mode == "getall" then
    if scanState.processing then return end
    scanState.processing = true
    scanState.cursor = 1
    chatMessage(string.format(L.SCAN_RECEIVED, GetNumAuctionItems("list")))
    frame:SetScript("OnUpdate", processGetAllChunk)
    return
  end
  local numOnPage, totalAuctions = GetNumAuctionItems("list")
  for index = 1, numOnPage do recordAuction(index) end
  local scannedSoFar = scanState.page * PAGE_SIZE + numOnPage
  if scannedSoFar < totalAuctions then
    scanState.page = scanState.page + 1
    local cadence = (WAH.settings and WAH.settings.verboseScan) and 1 or 10
    if scanState.page % cadence == 0 then
      chatMessage(string.format(L.SCAN_PAGE_PROGRESS, scanState.page, scannedSoFar, totalAuctions))
    end
    queryCurrentPage()
  else
    finishScan(totalAuctions)
  end
end)

-- Auto-rescan: while the AH stays open, restart a getAll scan whenever
-- the 15-minute cooldown elapses. Ticker is cheap; all real gating is
-- inside the check.
C_Timer.NewTicker(20, function()
  if not autoScanOn() or scanState then return end
  if not (AuctionFrame and AuctionFrame:IsShown()) then return end
  local _, canGetAll = CanSendAuctionQuery()
  if canGetAll then
    chatMessage(L.AUTO_TRIGGER)
    startScan()
  end
end)

-- Single history authority: points accumulated across scans plus the
-- 7d median derived from them. GUI chart, tooltip history, and the
-- deal radar all read through here.
function WAH.history(itemId)
  local pts = WoWderhoiAH_Points and WoWderhoiAH_Points[itemId]
  if not pts or #pts == 0 then return nil end
  local prices = {}
  for index, point in ipairs(pts) do prices[index] = point.c end
  table.sort(prices)
  local med7 = prices[math.ceil(#prices / 2)]
  return { pts = pts, med7 = med7, latest = pts[#pts].c }
end

SLASH_WOWDERHOIAH1 = "/wahscan"
SlashCmdList["WOWDERHOIAH"] = startScan
WAH.startScan = startScan

SLASH_WOWDERHOIAHAUTO1 = "/wahauto"
SlashCmdList["WOWDERHOIAHAUTO"] = function()
  WAH.settings.autoScan = not WAH.settings.autoScan
  chatMessage(WAH.settings.autoScan
    and L.AUTO_ON
    or L.AUTO_OFF)
end
