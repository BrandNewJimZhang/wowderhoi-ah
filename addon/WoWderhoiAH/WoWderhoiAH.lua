-- WoWderhoiAH Scanner for WoW Forever (client 1.60.1).
--
-- A full scan is C_AuctionHouse.ReplicateItems(): one server roundtrip that
-- replicates every listing, commodity and item auction alike. The 1.60
-- client is a modern-API client — QueryAuctionItems / GetAuctionItemInfo /
-- CanSendAuctionQuery do not exist, and there is no paged fallback to fall
-- back to. ReplicateItems is the supported replacement (the client's own
-- docs point an "all items" query at it).

local ADDON_NAME, WAH = ...
local L = WAH.L

local PROCESS_PER_FRAME = 200
local FRAME_BUDGET_MS = 8
-- A replicate scan is one server response; if it has not arrived by then,
-- the request was refused or lost. Abort loudly instead of leaving the
-- auto-rescan ticker blocked behind a scan that never finishes.
local SCAN_TIMEOUT_SECONDS = 120
local AUTO_SCAN_INTERVAL = 15 * 60

local scanState = nil -- { itemsById, itemInfoCache, cursor, total, processing }
local lastScanStartedAt = 0

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

local function autoScanOn()
  return WAH.settings and WAH.settings.autoScan
end

local frame = CreateFrame("Frame")
-- ReplicateItems publishes through the browse-result signals; item searches
-- publish through NEW_RESULTS_RECEIVED. Both are registered because the
-- client's exact signal depends on which query populated the results.
frame:RegisterEvent("AUCTION_HOUSE_SHOW")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_ADDED")
frame:RegisterEvent("AUCTION_HOUSE_NEW_RESULTS_RECEIVED")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")

local function chatMessage(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoWderhoiAH|r " .. text)
end

local function recordAuction(index)
  -- GetReplicateItemInfo return order: name, texture, count, quality, usable,
  -- level, levelType, minBid, minIncrement, buyoutPrice, bidAmount,
  -- highBidder, bidderFullName, owner, ownerFullName, saleStatus, itemID,
  -- hasAllInfo.
  local name, _, count, quality, _, _, _, _, _, buyoutPrice, _, _, _, _, _, _, itemId =
    C_AuctionHouse.GetReplicateItemInfo(index)
  -- Bid-only listings carry no buyout and cannot be bought out; the terminal
  -- prices what a buyer can pay today, so they are not part of the book.
  if not (itemId and name and buyoutPrice and buyoutPrice > 0 and count and count > 0) then return end
  local unitPrice = buyoutPrice / count
  local entry = scanState.itemsById[itemId]
  if not entry then
    local cached = scanState.itemInfoCache[itemId]
    if cached == nil then
      -- GetItemInfo is the single most expensive call per new itemId. Cache
      -- it for the scan's lifetime; a repeat listing reuses one call.
      local _, _, _, _, _, itemClass, itemSubClass = WAH.getItemInfo(itemId)
      local vendorPrice = select(11, WAH.getItemInfo(itemId))
      if itemClass == nil and C_Item and C_Item.RequestLoadItemDataByID then
        -- The item database loads lazily on modern clients. Ask once so the
        -- next scan can price vendor arbitrage for this item.
        C_Item.RequestLoadItemDataByID(itemId)
      end
      cached = { class = itemClass, subClass = itemSubClass, vendorP = vendorPrice or 0 }
      scanState.itemInfoCache[itemId] = cached
    end
    entry = {
      name = name,
      quality = quality,
      itemClass = cached.class,
      itemSubClass = cached.subClass,
      vendorP = cached.vendorP,
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

-- Quantity-weighted percentile: the unit price at which `fraction` of the
-- listed quantity sits at or below. This realm's upper book is noise — thin,
-- stale listings nobody transacts against — so only the bottom decile
-- reflects real trade. Percentiles shrug off bait stacks that wreck a mean.
local function weightedPercentile(sortedListings, totalQuantity, fraction)
  local threshold = totalQuantity * fraction
  local cumulative = 0
  for _, listing in ipairs(sortedListings) do
    cumulative = cumulative + listing.count
    if cumulative >= threshold then return listing.price end
  end
  return sortedListings[#sortedListings].price
end

-- Depth-aware sell front: the cheapest price with real quantity behind it.
-- Lone dump listings ahead of it sell out in minutes; undercutting them
-- gives gold away. Threshold: 3% of listed supply, at least 3 units.
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
      p5 = math.floor(weightedPercentile(entry.listings, entry.quantity, 0.05) + 0.5),
      marketPrice = math.floor(weightedPercentile(entry.listings, entry.quantity, 0.10) + 0.5),
      quantity = entry.quantity,
      numAuctions = entry.numAuctions
    }
    itemCount = itemCount + 1
  end
  -- Every stored point carries the pipeline's close price, so a pipeline
  -- bump redefines what the whole series means. Drop points recorded by an
  -- older pipeline on the first scan after a bump.
  local previousVersion = WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.dataVersion
  if previousVersion and previousVersion ~= WAH.PIPELINE_VERSION then
    WoWderhoiAH_Points = nil
  end
  WoWderhoiAH_ScanData = {
    dataVersion = WAH.PIPELINE_VERSION, -- consumers reject anything else
    scannedAt = time(),
    server = GetRealmName(),
    faction = UnitFactionGroup("player"),
    items = items
  }
  -- Accumulate per-item price points in game: c is the P10 close — the price
  -- a buyer actually pays on this realm — and feeds the chart, the 7d P10
  -- median and the deal radar alike. 7-day window, newest 192 points per
  -- item (~48 h at the 15-minute auto-scan cadence).
  WoWderhoiAH_Points = WoWderhoiAH_Points or {}
  local nowTs = time()
  local cutoff = nowTs - 7 * 24 * 3600
  for itemId, item in pairs(items) do
    local pts = WoWderhoiAH_Points[itemId] or {}
    pts[#pts + 1] = { t = nowTs, c = item.marketPrice }
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
  scanState = { itemsById = {}, itemInfoCache = {}, processing = false }
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
    chatMessage(L.SCAN_TIMEOUT)
  end)
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
  -- A NEW_RESULTS_RECEIVED with an itemKey belongs to an item search; only
  -- the nil-payload form can announce a browse/replicate response. Letting
  -- the item-search form through would make a player's search consume the
  -- previous scan's replicate count while the new response is in flight.
  if event == "AUCTION_HOUSE_NEW_RESULTS_RECEIVED" and payload ~= nil then return end
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
-- interval elapses. The ticker is cheap; all real gating is in the check.
C_Timer.NewTicker(20, function()
  if not autoScanOn() or scanState then return end
  if not ahIsOpen() then return end
  if time() - lastScanStartedAt < AUTO_SCAN_INTERVAL then return end
  chatMessage(L.AUTO_TRIGGER)
  startScan()
end)

-- Single history authority: points accumulated across scans plus the 7d P10
-- median derived from them. GUI chart, tooltip history, and the deal radar
-- all read through here.
function WAH.history(itemId)
  local pts = WoWderhoiAH_Points and WoWderhoiAH_Points[itemId]
  if not pts or #pts == 0 then return nil end
  local prices = {}
  for index, point in ipairs(pts) do prices[index] = point.c end
  table.sort(prices)
  local med7 = prices[math.ceil(#prices / 2)]
  -- Distinct closes in the window. A flat series means one camper's ask
  -- recorded over and over, so med7 is a price nothing traded against; the
  -- deal radar refuses to discount from it.
  local distinct = 1
  for index = 2, #prices do
    if prices[index] ~= prices[index - 1] then distinct = distinct + 1 end
  end
  return { pts = pts, med7 = med7, latest = pts[#pts].c, distinct = distinct }
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
