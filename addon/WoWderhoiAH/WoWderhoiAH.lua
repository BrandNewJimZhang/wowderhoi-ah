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
-- How long the request may wait for its answer. The client has no upper
-- bound of its own; the watchdog only reports "no answer", and it stops
-- existing the moment rows start arriving. Processing time is never a
-- failure: the copy is already in Lua memory.
local REPLICATE_WAIT_SECONDS = 180
-- Progress is announced every tenth of the book, so a slow scan under a low
-- frame rate reads as slow rather than hung.
local PROGRESS_STEP = 0.1
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
-- One scan, one owner. The phase is explicit rather than inferred from
-- booleans: waiting -> rows -> finish -> saved, with abort as the only other
-- exit. `attemptId` makes every delayed callback check that it still owns
-- the scan it was scheduled for.
local scan = nil
-- The finish phase runs across frames like the row loop: a 170k scan
-- collapses to thousands of books, and aggregating them all in one
-- OnUpdate is the stall a player actually feels at the end of a scan.
local finish = nil
local scanAttempt = 0

-- Item metadata resolved once per session, not once per scan. The client's
-- item database loads lazily, so an unresolved lookup is retried next scan
-- instead of caching a nil class and a zero vendor price forever.
local itemInfoCache = {}
-- Admission state moves into SavedVariables in a later step; these two keep
-- the ticker and the retry hint working until then.
local lastScanStartedAt = 0
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
local flushTimer = 0
local flushPending = false

function WAH.flush()
  -- An immediate save supersedes a queued one.
  flushTimer = flushTimer + 1
  flushPending = false
  if C_AddOns and C_AddOns.SaveAddOns then pcall(C_AddOns.SaveAddOns) end
end

-- Coalesced save for journal writes. A buy, a post, a craft and a manual
-- entry all change the ledger, and none of them should wait for the next
-- scan to reach the terminal. Batching through one delayed save keeps a
-- mailbox sweep or a crafting spree from rewriting the file per event.
function WAH.requestFlush(delay)
  if flushPending then return end
  if not (C_Timer and C_Timer.After) then
    -- No scheduler to coalesce with: save now rather than lose the batch.
    WAH.flush()
    return
  end
  flushPending = true
  flushTimer = flushTimer + 1
  local token = flushTimer
  C_Timer.After(delay or 2, function()
    if flushTimer ~= token then return end
    flushPending = false
    WAH.flush()
  end)
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

-- Only an item link carries a trader panel. SetHyperlink receives the raw
-- "item:id:..." form; GetItem returns the full "|Hitem:id:...|h[name]|h"
-- form. Both are anchored, so a spell/unit/battlepet link, or a string that
-- merely contains "item:" somewhere, is rejected. Pasted item links often
-- carry a color prefix before |H, which the third form accepts.
function WAH.itemIdFromLink(link)
  if type(link) ~= "string" then return nil end
  local id = link:match("^item:(%d+)")
    or link:match("^|Hitem:(%d+)")
    or link:match("^|c%x%x%x%x%x%x%x%x|Hitem:(%d+)")
  return tonumber(id)
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

-- Free bag slots across the backpack and the four equipped bags. The
-- aggregate is the executable-quantity ceiling; stackSize x slots assumes
-- every item stacks to the client maximum, so it can overstate how many
-- units fit when the item stacks smaller. Reading each item's own stack
-- size per candidate would be exact but costs a GetItemInfo per row, and
-- the budget and the book depth usually bind first.
local function freeBagSlots()
  if not (C_Container and C_Container.GetContainerNumFreeSlots) then return 20 end
  local total = 0
  for bag = 0, 4 do
    total = total + (C_Container.GetContainerNumFreeSlots(bag) or 0)
  end
  return total
end
-- /wahdiag compares the live count with the one the last scan reported to
-- the terminal; a mismatch means the import is sizing against stale bags.
WAH.freeBagSlots = freeBagSlots

-- ============================== Capture ==============================

-- ============================ Own listings ===========================
--
-- The market is a fact about everyone else. A scan that counts the
-- player's own listings as supply makes the sell front self-referential:
-- the sell page then advises undercutting yourself, the seller gate is
-- satisfied by your own name, and your purchase disappears from the book
-- and is booked as demand. Owners are compared without the realm suffix;
-- when the client hides owners, the owned-auction list is the fallback.

local ownOwner -- false caches "no name available"
-- Owner strings repeat on every listing of the same seller, so the strip
-- and lower-case work is done once per distinct name, not once per row.
local normalizedOwner = {}
local function normalizeOwner(value)
  if type(value) ~= "string" then return nil end
  local cached = normalizedOwner[value]
  if cached then return cached end
  local name = value:match("^([^%-]+)") or value
  if name == "" then return nil end
  name = name:lower()
  normalizedOwner[value] = name
  return name
end

local function ownOwnerKey()
  if ownOwner == nil then
    ownOwner = normalizeOwner(UnitName and UnitName("player")) or false
  end
  return ownOwner
end

-- itemId -> array of { buyout, count }. Refreshed when the auction house
-- opens and when the client answers QueryOwnedAuctions.
local ownedSnapshot = nil

-- Reads whatever the client currently holds. The event handler calls this
-- directly: QueryOwnedAuctions fires the event (synchronously on some
-- builds), so a refresh that queried again would recurse.
local function captureOwnedSnapshot()
  if not (C_AuctionHouse.GetNumOwnedAuctions and C_AuctionHouse.GetOwnedAuctionInfo) then
    ownedSnapshot = nil
    return
  end
  local byItem = {}
  local count = C_AuctionHouse.GetNumOwnedAuctions() or 0
  for index = 1, count do
    local info = C_AuctionHouse.GetOwnedAuctionInfo(index)
    local itemId = info and info.itemKey and info.itemKey.itemID
    if itemId then
      local list = byItem[itemId]
      if not list then
        list = {}
        byItem[itemId] = list
      end
      list[#list + 1] = {
        buyout = info.buyoutAmount or info.bidAmount or 0,
        count = info.quantity or 1
      }
    end
  end
  ownedSnapshot = byItem
end

local function refreshOwnedSnapshot()
  if C_AuctionHouse.QueryOwnedAuctions then pcall(C_AuctionHouse.QueryOwnedAuctions) end
  captureOwnedSnapshot()
end

-- One matched listing is consumed: three identical postings are three
-- separate rows, not one row seen three times.
local function consumeOwnedMatch(itemId, buyoutPrice, count)
  local list = ownedSnapshot and ownedSnapshot[itemId]
  if not list then return false end
  for index = 1, #list do
    local row = list[index]
    if row.buyout == buyoutPrice and row.count == count then
      table.remove(list, index)
      return true
    end
  end
  return false
end

-- A flow key is (owner, unit price); its value is the remaining quantity and
-- the shortest time left. At 170k listings the pair table was the scan's
-- dominant allocation and dominated the SavedVariables file. One double
-- carries both values exactly: the quantity in the high bits and a time-left
-- code in the low 20 bits (48h is 172,800 seconds, so 2^20 has headroom).
local FLOW_SCALE = 1048576
local function packFlow(quantity, timeLeft)
  -- Clamp a surprising client value instead of letting it carry into the
  -- quantity field; the decoded time then reads as "longer than any window".
  local code = timeLeft and math.min(timeLeft + 1, FLOW_SCALE - 1) or 0
  return quantity * FLOW_SCALE + code
end
local function flowQuantity(packed)
  return math.floor(packed / FLOW_SCALE)
end
local function flowTimeLeft(packed)
  local code = packed % FLOW_SCALE
  if code == 0 then return nil end
  return code - 1
end

local function newEntry(name, quality, cached)
  return {
    name = name,
    quality = quality,
    itemClass = cached.class,
    itemSubClass = cached.subClass,
    vendorP = cached.vendorP,
    minPrice = nil,
    tierQuantity = {}, -- unitPrice -> quantity, aggregated as rows arrive
    -- owner ("" when hidden) -> unitPrice -> packFlow(quantity, timeLeft).
    -- Matched across scans to infer disappearances.
    flow = {},
    ownerTotals = {}, -- owner -> quantity across all prices, detects repricing
    bidAmount = 0,
    bidOnly = 0,
    hasBuyout = false,
    -- One table carries both the distinct-seller count and the supply the
    -- concentration measure reads. Bid-only rows enter with 0 supply so a
    -- seller who only bids still counts as present.
    sellerUnknown = false,
    -- True when at least one row named its owner. Partial visibility keeps
    -- sellerUnknown set, so the fill model treats the book as unobservable.
    ownerVisible = false,
    selfExclusion = nil, -- "owner" | "owned"; nil resolved to "none"/"owner"
    selfQty = 0,
    selfListings = 0,
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
  --
  -- Every client lookup counts as API time, including the per-item
  -- GetItemInfo below. Everything else is our own aggregation; /wahdiag
  -- subtracts apiMs from processMs to report the two separately.
  local apiStart = debugprofilestop()
  local name, _, count, quality, _, _, _, _, _, buyoutPrice, bidAmount, _, _,
    owner, ownerFullName, _, itemId = C_AuctionHouse.GetReplicateItemInfo(index)
  local timeLeft = C_AuctionHouse.GetReplicateItemTimeLeft
    and timeLeftSeconds(C_AuctionHouse.GetReplicateItemTimeLeft(index)) or nil
  scan.apiMs = (scan.apiMs or 0) + (debugprofilestop() - apiStart)
  -- A row the client cannot return means the copy was cleared under the
  -- scan. Counting it is what lets the row phase refuse to publish a book
  -- with silent holes instead of treating it as a complete observation.
  if not itemId then
    scan.badRows = (scan.badRows or 0) + 1
    return
  end
  if not name then return end
  local seller = owner or ownerFullName

  local entry = scan.itemsById[itemId]
  if not entry then
    local cached = itemInfoCache[itemId]
    if not cached then
      -- GetItemInfo is the single most expensive call per new itemId. Read
      -- every field once, cache it for the session, and let repeat listings
      -- and later scans reuse the result. It is a client lookup, so its time
      -- belongs to apiMs rather than the surrounding Lua aggregation.
      local infoStart = debugprofilestop()
      local _, _, _, _, _, itemClass, itemSubClass, _, _, _, vendorPrice = WAH.getItemInfo(itemId)
      scan.apiMs = (scan.apiMs or 0) + (debugprofilestop() - infoStart)
      cached = { class = itemClass, subClass = itemSubClass, vendorP = vendorPrice or 0 }
      if itemClass ~= nil then
        itemInfoCache[itemId] = cached
      elseif C_Item and C_Item.RequestLoadItemDataByID then
        -- The item database loads lazily on modern clients. Ask once so the
        -- next scan can price vendor arbitrage for this item.
        local requestStart = debugprofilestop()
        C_Item.RequestLoadItemDataByID(itemId)
        scan.apiMs = (scan.apiMs or 0) + (debugprofilestop() - requestStart)
      end
    end
    entry = newEntry(name, quality, cached)
    scan.itemsById[itemId] = entry
  end

  -- Own listings are not market supply. Identify by owner name first; when
  -- the client hides owners, match the owned-auction list by item, buyout
  -- and quantity. A listing that cannot be attributed stays in the book.
  local selfListing = false
  if seller then
    entry.ownerVisible = true
    if normalizeOwner(seller) == ownOwnerKey() then
      selfListing = true
      entry.selfExclusion = "owner"
    end
  else
    entry.sellerUnknown = true
    if buyoutPrice and buyoutPrice > 0 and count and count > 0
      and consumeOwnedMatch(itemId, buyoutPrice, count) then
      selfListing = true
      entry.selfExclusion = entry.selfExclusion or "owned"
    end
  end

  if selfListing then
    entry.selfQty = entry.selfQty + (count or 0)
    entry.selfListings = entry.selfListings + 1
    return
  end

  local buyable = buyoutPrice and buyoutPrice > 0 and count and count > 0
  if seller then
    entry.ownerTotals[seller] = (entry.ownerTotals[seller] or 0) + (buyable and count or 0)
  end
  if bidAmount and bidAmount > (entry.bidAmount or 0) then entry.bidAmount = bidAmount end

  -- Bid-only listings carry no buyout and cannot be bought out. They are
  -- still the only direct demand signal the client publishes, so they are
  -- counted instead of silently dropped.
  if not buyable then
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
    local shortest = flowTimeLeft(flow)
    if timeLeft and (not shortest or timeLeft < shortest) then shortest = timeLeft end
    ownerFlow[unitPrice] = packFlow(flowQuantity(flow) + count, shortest)
  else
    ownerFlow[unitPrice] = packFlow(count, timeLeft)
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
  for _ in pairs(entry.ownerTotals) do count = count + 1 end
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
  -- Within the per-scan window the layered retention keeps every point
  -- unchanged. Rebuilding five arrays per item per scan was pure garbage;
  -- the common case returns the series it was given.
  if series.t[1] and series.t[1] >= nowTs - DAY then return series end
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

-- Append one scan point for one item. Demand-only rows carry no price;
-- keeping their zeros in the series would drag every sell-median and chart
-- toward 0, so they return nil and are never stored.
local function appendSeriesPoint(market, itemId, item, nowTs)
  if not (item.minPrice and item.minPrice > 0) then return nil end
  local series = market.items[itemId]
  if not series then
    series = { t = {}, min = {}, sell = {}, q = {}, e = {} }
    market.items[itemId] = series
  end
  appendPoint(series, item, nowTs)
  series = pruneSeries(series, nowTs)
  market.items[itemId] = series
  return series
end

-- The window every history sample is counted over. Ignition has no window
-- of its own, so trend and chart statistics borrow the steady window from
-- the same compiled table instead of restating the number.
local function historyWindowForPhase(phase)
  local rule = WAH.RULES.phaseHistory[phase]
  local window = rule and rule.windowHours or 0
  if window <= 0 then window = WAH.RULES.phaseHistory.steady.windowHours end
  return window
end

-- Sample count within one window. The decision core reads only this
-- number, so neither runtime builds chart points to count them.
local function seriesSamples(series, nowTs, windowHours)
  if not series or #series.t == 0 then return 0 end
  local cutoff = nowTs - (windowHours or 0) * HOUR
  local count = 0
  for index = 1, #series.t do
    if series.t[index] >= cutoff then count = count + 1 end
  end
  -- An item whose retained points all predate the window still has one
  -- usable sample: its latest point, matching WAH.historySamples.
  return count > 0 and count or 1
end

-- The per-item work is done; drop empty series and enforce the global cap
-- once, rather than rebuilding every item's arrays on every scan.
local function finalizeSeries(market)
  for itemId, series in pairs(market.items) do
    if #series.t == 0 then market.items[itemId] = nil end
  end
  enforceSeriesCap(market)
end

-- ============================== Finish ===============================

local function previousCapture()
  local capture = WoWderhoiAH_Capture
  if type(capture) ~= "table" or capture.v ~= WAH.PIPELINE_VERSION then return nil end
  -- A capture written by another flow encoding cannot be matched. The first
  -- scan after an upgrade starts a fresh baseline instead of reading an old
  -- shape with the new meaning.
  if capture.shape ~= "owner-price-packed" then return nil end
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
local function inferFlow(entry, previous, elapsedSeconds, ownBought)
  if not previous or elapsedSeconds <= 0 then return 0, 0, 0 end
  local high = 0
  local liveOwners = {}
  for owner, prices in pairs(previous.keys or {}) do
    local nowByPrice = entry.flow[owner]
    local liveQuantity = 0
    for price, packed in pairs(prices) do
      local wasQuantity = flowQuantity(packed)
      local wasTime = flowTimeLeft(packed)
      local now = nowByPrice and nowByPrice[price]
      local remaining = now and flowQuantity(now) or 0
      -- A listing cannot have sold if its previous remaining time was shorter
      -- than the gap between scans: that disappearance is an expiry.
      local live = wasTime and wasTime > elapsedSeconds + 60
      if wasQuantity > remaining and (not wasTime or live) then
        high = high + (wasQuantity - remaining)
      end
      -- Only units that could not have expired contribute to the lower
      -- edge; an owner total that moved between prices stays unchanged.
      if live then liveQuantity = liveQuantity + wasQuantity end
    end
    if liveQuantity > 0 and owner ~= "" then liveOwners[owner] = liveQuantity end
  end
  local low = 0
  for owner, quantity in pairs(liveOwners) do
    local remaining = entry.ownerTotals[owner] or 0
    if quantity > remaining then low = low + (quantity - remaining) end
  end
  low = math.min(low, high)
  -- The player's own purchases look exactly like demand in the book: units
  -- leave a seller's row. They are not evidence that anyone else will buy,
  -- so remove them from both edges before they reach the fill model.
  local own = math.max(ownBought or 0, 0)
  if own > 0 then
    low = math.max(0, low - own)
    high = math.max(0, high - own)
  end
  local elapsedHours = math.max(elapsedSeconds / HOUR, SCAN_FLOOR_HOURS)
  local supplyGrowth = 0
  if previous.total and previous.total > 0 then
    -- Use the lower edge: assuming fewer sales can only overstate new supply,
    -- which is the conservative direction for a bubble warning.
    supplyGrowth = ((entry.quantity - previous.total) + low) / (previous.total * elapsedHours)
  end
  return low, high, supplyGrowth
end

-- Seller concentration over the other players' supply. HHI is the standard
-- measure: 1 means one seller holds the book, 1/n means an even split.
local function sellerConcentration(entry)
  -- Owner totals only see the rows that named a seller. On a partially
  -- hidden book the visible subset would look like a monopoly, so the
  -- measure is unknown, not high.
  if entry.sellerUnknown then return nil end
  local total = 0
  local shares = {}
  for seller, quantity in pairs(entry.ownerTotals) do
    -- An empty seller key never reaches ownerTotals (hidden-owner rows are
    -- not attributed), but guard anyway.
    if seller ~= "" and quantity > 0 then
      shares[#shares + 1] = quantity
      total = total + quantity
    end
  end
  if total <= 0 or #shares == 0 then return nil end
  local hhi, top = 0, 0
  for _, quantity in ipairs(shares) do
    local share = quantity / total
    hhi = hhi + share * share
    if share > top then top = share end
  end
  return hhi, top
end

-- Aggregate one item's book. The finish phase calls this inside a frame
-- budget, one book at a time, so a 6,000-book market cannot stall a frame.
local function finishItem(itemId)
  local entry = scan.itemsById[itemId]
  if not entry then return end
  -- Release the row accumulator as soon as its book is aggregated; at 170k
  -- listings the flow tables are the largest structure alive during finish.
  scan.itemsById[itemId] = nil
  finish.itemCount = finish.itemCount + 1

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
      early = finish.phase == "ignition"
    })
    local sellers = countSellers(entry)
    local sellersInvisible = entry.sellerUnknown
    if sellersInvisible then sellers = entry.numAuctions end
    -- A disappearance needs a baseline. Without a previous capture of this
    -- item there was nothing to disappear from, so a zero interval is
    -- missing data, not an observed zero: the core would otherwise shrink
    -- the fill estimate toward zero for every first scan and every item
    -- listed between scans, and the calibration would learn those zeros.
    local previousItem = finish.previous and finish.previous.items[itemId]
    local flowObserved = previousItem ~= nil and finish.elapsedSeconds > 0
    local soldLow, soldHigh, supplyGrowth = inferFlow(
      entry, previousItem, finish.elapsedSeconds, finish.ownBuys[itemId])
    local sellerHHI, topSellerShare = sellerConcentration(entry)
    local item = {
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
      -- Owner visibility and the exclusion channel. "none" means owners
      -- were hidden and the owned list did not identify the listings, so
      -- the book may still contain them; the calibration ignores it.
      ownerVisible = entry.ownerVisible,
      selfExclusion = entry.selfExclusion or (entry.sellerUnknown and "none" or "owner"),
      selfQty = entry.selfQty,
      selfListings = entry.selfListings,
      sellerHHI = sellerHHI,
      topSellerShare = topSellerShare,
      bidOnly = entry.bidOnly,
      highestBid = math.floor((entry.bidAmount or 0) + 0.5),
      tiers = storedTiers,
      -- Only the cheapest eight rungs are persisted. The core uses this to
      -- treat the unseen deep book as a queue instead of an empty one.
      tierTruncated = #tiers > #storedTiers,
      expiring = entry.expiring,
      inferredSoldLow = soldLow,
      inferredSoldHigh = soldHigh,
      flowObserved = flowObserved,
      supplyGrowth = supplyGrowth,
      elapsedHours = math.max(finish.elapsedSeconds / HOUR, SCAN_FLOOR_HOURS)
    }
    -- The sample count is a property of the series at scan time. Stamping it
    -- here means a radar refresh reads one number instead of walking every
    -- retained point of every item.
    local series = appendSeriesPoint(finish.market, itemId, item, finish.nowTs)
    item.historySamples = series and seriesSamples(series, finish.nowTs, finish.seriesWindow) or 0
    finish.items[itemId] = item
    finish.captureItems[itemId] = {
      keys = entry.flow,
      total = entry.quantity
    }
  elseif entry.bidOnly > 0 then
    local item = {
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
      ownerVisible = entry.ownerVisible,
      selfExclusion = entry.selfExclusion or (entry.sellerUnknown and "none" or "owner"),
      selfQty = entry.selfQty,
      selfListings = entry.selfListings,
      bidOnly = entry.bidOnly,
      highestBid = math.floor((entry.bidAmount or 0) + 0.5),
      tiers = {},
      expiring = entry.expiring,
      inferredSoldLow = 0,
      inferredSoldHigh = 0,
      supplyGrowth = 0,
      historySamples = 0
    }
    finish.items[itemId] = item
  end
end

-- Every exit writes the same record: success, no response, browse failure,
-- a closed auction house or a cleared replicate. /wahdiag can then answer
-- which phase the scan actually reached instead of only naming the last
-- symptom. A reason of nil means the scan saved.
local function buildScanStats(reason)
  local s, f = scan, finish
  local apiMs = s and s.apiMs or 0
  local processMs = s and s.processMs or 0
  WAH.lastScanStats = {
    attemptId = s and s.attemptId or 0,
    phase = s and s.phase or "idle",
    reason = reason,
    rows = s and math.max(0, (s.cursor or 1) - 1) or 0,
    cursor = s and math.max(0, (s.cursor or 1) - 1) or 0,
    total = s and s.total or 0,
    waitMs = s and s.waitMs or 0,
    apiMs = apiMs,
    processMs = processMs,
    luaMs = math.max(0, processMs - apiMs),
    finishMs = f and f.finishMs or 0,
    finishFrameMaxMs = f and f.frameMaxMs or 0,
    finishFrames = f and f.frames or 0,
    frames = s and s.frames or 0,
    responseVia = s and s.responseVia,
    itemsMissingInfo = s and s.itemsMissingInfo or 0,
    badRows = s and s.badRows or 0,
    seriesBudget = f and f.seriesBudget or (s and s.seriesBudget),
    saveMs = 0
  }
  return WAH.lastScanStats
end

-- Write SavedVariables one frame after the last aggregation frame, so the
-- payload serialisation is not part of the finish stall. The desktop watcher
-- still sees the scan within seconds, not at the next logout.
local function flushFinishedScan()
  if not finish then return end
  -- The last finish frame also builds ScanData/Capture and enforces the
  -- series cap. Publishing the stats here attributes that work instead of
  -- reporting the finish as if assembly were free.
  local stats = buildScanStats(nil)
  stats.phase = "saved"
  local saveStart = debugprofilestop()
  WAH.flush()
  stats.saveMs = debugprofilestop() - saveStart
  finish = nil
  scan = nil
  WAH.scanRunning = false
  frame:SetScript("OnUpdate", nil)
end

local function finalizeFinish()
  WoWderhoiAH_ScanData = {
    dataVersion = WAH.PIPELINE_VERSION,
    -- The inferred flow's hygiene level; the terminal labels every snapshot
    -- with it so a calibration never mixes pre-hygiene rows with clean ones.
    observationVersion = WAH.OBSERVATION_VERSION,
    scannedAt = finish.nowTs,
    server = GetRealmName(),
    faction = UnitFactionGroup("player"),
    character = UnitName and UnitName("player") or nil,
    cash = GetMoney and GetMoney() or 0,
    -- Epoch of the server's opening time; 0 means "not set". Always sent so
    -- /wahopen auto can clear the anchor the terminal kept; without it the
    -- terminal would fall back to the earliest scan, which a fresh install
    -- resets to "just opened".
    openedAt = (WAH.settings and WAH.settings.serverOpenedAt) or 0,
    -- Free bag slots at scan time. The terminal runs the same decision core
    -- but cannot see the player's bags; without this it sized every
    -- recommendation against a planning constant.
    bagSlots = freeBagSlots(),
    total = finish.totalAuctions or 0,
    items = finish.items
  }
  WoWderhoiAH_Capture = {
    v = WAH.PIPELINE_VERSION,
    shape = "owner-price-packed",
    at = finish.nowTs,
    market = marketKey(),
    items = finish.captureItems
  }
  finalizeSeries(finish.market)
  scan.phase = "saved"
  chatMessage(string.format(
    L.SCAN_COMPLETE .. "%s",
    finish.totalAuctions or 0, finish.itemCount,
    autoScanOn() and string.format(L.SCAN_AUTO_ARMED, SCAN_MINUTES) or ""))
  frame:SetScript("OnUpdate", flushFinishedScan)
end

local function processFinishChunk()
  if not finish then return end
  local frameStart = debugprofilestop()
  local cursor = finish.cursor
  -- The item count is fixed: consumed entries are cleared, so `#` on the
  -- list would no longer be reliable.
  while cursor <= finish.count and debugprofilestop() - frameStart < FRAME_BUDGET_MS do
    finishItem(finish.itemIds[cursor])
    finish.itemIds[cursor] = nil
    cursor = cursor + 1
  end
  finish.cursor = cursor
  -- Assembly belongs to this frame's cost: it is real work the client
  -- pauses for, and hiding it from finishMs would understate the stall.
  if cursor > finish.count then finalizeFinish() end
  local frameMs = debugprofilestop() - frameStart
  finish.finishMs = finish.finishMs + frameMs
  finish.frames = finish.frames + 1
  if frameMs > finish.frameMaxMs then finish.frameMaxMs = frameMs end
end

local function beginFinish(totalAuctions)
  scan.phase = "finish"
  -- A pipeline bump redefines every field, so old data is discarded rather
  -- than reinterpreted. This reset must run before the new series is read.
  local previousScan = WoWderhoiAH_ScanData
  local previousVersion = previousScan and previousScan.dataVersion
  if previousVersion and previousVersion ~= WAH.PIPELINE_VERSION then
    WoWderhoiAH_Series = nil
    WoWderhoiAH_Capture = nil
  end
  local nowTs = time()
  local market = ensureSeries()
  market.firstScanAt = math.min(market.firstScanAt or nowTs, nowTs)
  local phase = WAH.currentPhase and WAH.currentPhase() or "steady"
  local previous = scan.capture
  local elapsedSeconds = previous and (nowTs - (previous.at or nowTs)) or 0
  -- The journal is the only place a purchase is a fact. The flow inference
  -- subtracts these units; see inferFlow.
  local ownBuys = {}
  if previous and previous.at and WAH.Ledger and WAH.Ledger.purchasesBetween then
    ownBuys = WAH.Ledger.purchasesBetween(previous.at, nowTs)
  end
  local itemIds = {}
  for itemId in pairs(scan.itemsById) do itemIds[#itemIds + 1] = itemId end
  -- The per-item history budget follows the market's breadth: a fixed cap
  -- divided by a growing item count silently shrinks every item's window.
  local seriesBudget = math.max(8, math.floor(SERIES_CAP / math.max(1, #itemIds)))
  scan.seriesBudget = seriesBudget
  finish = {
    totalAuctions = totalAuctions,
    seriesBudget = seriesBudget,
    nowTs = nowTs,
    market = market,
    phase = phase,
    previous = previous,
    elapsedSeconds = elapsedSeconds,
    ownBuys = ownBuys,
    itemIds = itemIds,
    count = #itemIds,
    cursor = 1,
    items = {},
    captureItems = {},
    itemCount = 0,
    seriesWindow = historyWindowForPhase(phase),
    waitMs = scan.waitMs or 0,
    processMs = scan.processMs or 0,
    apiMs = scan.apiMs or 0,
    finishMs = 0,
    frameMaxMs = 0,
    frames = 0
  }
end

local abortScan -- forward declaration: the row loop can detect a cleared copy

local function stopScanTimers(s)
  if s.watchdog then s.watchdog:Cancel(); s.watchdog = nil end
  if s.hydrateTimer then s.hydrateTimer:Cancel(); s.hydrateTimer = nil end
end

local function processReplicateChunk()
  if not scan or scan.phase ~= "rows" then return end
  local total = scan.total or 0
  local index = scan.cursor or 1
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
  scan.cursor = index
  scan.processMs = (scan.processMs or 0) + (debugprofilestop() - frameStart)
  scan.frames = (scan.frames or 0) + 1
  if index <= total and scan.nextProgress and index > scan.nextProgress then
    chatMessage(string.format(L.SCAN_PROGRESS, index - 1, total))
    repeat
      scan.nextProgress = scan.nextProgress + scan.progressStep
    until scan.nextProgress > index - 1
  end
  if index > total then
    -- A row the client could not return means the copy was cleared under
    -- us. Publishing the remainder would be a snapshot with silent holes.
    if (scan.badRows or 0) > 0 then
      abortScan("replicate_cleared")
      return
    end
    -- Keep the OnUpdate alive: the finish phase slices its own work.
    frame:SetScript("OnUpdate", processFinishChunk)
    beginFinish(total)
  end
end

local function startRows()
  if not scan or scan.phase ~= "waiting" then return end
  scan.phase = "rows"
  scan.cursor = 1
  if scan.watchdog then scan.watchdog:Cancel(); scan.watchdog = nil end
  -- Time spent waiting for the server, kept apart from the time spent
  -- processing it: only one of the two is ours.
  scan.waitMs = debugprofilestop() - (scan.requestProfile or debugprofilestop())
  -- Progress is per tenth of the book, with at least one row per step so a
  -- tiny scan neither divides by zero nor spams the chat frame.
  scan.progressStep = math.max(1, math.floor((scan.total or 0) * PROGRESS_STEP))
  scan.nextProgress = scan.progressStep
  chatMessage(string.format(L.SCAN_RECEIVED, scan.total))
  frame:SetScript("OnUpdate", processReplicateChunk)
end

-- The dedicated replicate event is the acknowledgement. The browse signals
-- stay as a fallback for client builds that publish the copy there, but a
-- browse event alone cannot prove the copy answers THIS request: an old
-- replicate still in memory would be consumed as a fresh scan. The fallback
-- therefore requires a non-zero copy and no player search in flight.
local function acceptReplicate(via)
  if not scan or scan.phase ~= "waiting" then return end
  local total = C_AuctionHouse.GetNumReplicateItems() or 0
  if total == 0 then
    if via == "replicate" then abortScan("empty") end
    return
  end
  scan.total = total
  scan.responseVia = via
  startRows()
end

abortScan = function(reason)
  local s = scan
  if not s then return end
  stopScanTimers(s)
  frame:SetScript("OnUpdate", nil)
  -- Stats read the scan and the finish table, so they must be built before
  -- either is released.
  buildScanStats(reason)
  scan = nil
  finish = nil
  WAH.scanRunning = false
  if reason == "no_response" then
    chatMessage(string.format(L.SCAN_NO_RESPONSE, REPLICATE_WAIT_SECONDS))
  elseif reason == "browse_failure" then
    chatMessage(L.SCAN_BROWSE_FAILURE)
  elseif reason == "replicate_cleared" then
    chatMessage(string.format(L.SCAN_REPLICATE_CLEARED, s.badRows or 0))
  elseif reason == "empty" then
    chatMessage(L.SCAN_EMPTY_RESPONSE)
  else
    chatMessage(L.SCAN_ABORTED)
  end
  if reason == "no_response" or reason == "browse_failure" then
    backoffUntil = time() + REPLICATE_WAIT_SECONDS
  end
end

local function ahIsOpen()
  if WAH.ahOpen then return true end
  local auctionHouse = WAH.ahFrame()
  return auctionHouse ~= nil and auctionHouse:IsShown()
end

local function startScan()
  if not ahIsOpen() then
    chatMessage(L.SCAN_OPEN_AH_FIRST)
    return false
  end
  if scan then
    chatMessage(L.SCAN_ALREADY_RUNNING)
    return false
  end
  -- The owned list is the fallback for hidden owners, and it must reflect
  -- the book as it is at scan start; a listing bought since the last query
  -- would otherwise be matched against a stale list.
  refreshOwnedSnapshot()
  scanAttempt = scanAttempt + 1
  scan = {
    attemptId = scanAttempt,
    phase = "waiting",
    cursor = 1,
    itemsById = {},
    processMs = 0,
    apiMs = 0,
    frames = 0,
    waitMs = 0,
    badRows = 0,
    missingInfo = {},
    resolvedInfo = {},
    itemsMissingInfo = 0,
    requestAt = time(),
    requestProfile = debugprofilestop(),
    capture = previousCapture()
  }
  WAH.scanRunning = true
  lastScanStartedAt = time()
  chatMessage(L.SCAN_GETALL_START)
  local attempt = scan.attemptId
  C_AuctionHouse.ReplicateItems()
  -- A cancelable waiting watchdog, not a scan deadline. startRows cancels
  -- it, so a response that takes two minutes and a row phase that takes
  -- twenty are both successful outcomes.
  scan.watchdog = C_Timer.NewTimer(REPLICATE_WAIT_SECONDS, function()
    if scan and scan.attemptId == attempt and scan.phase == "waiting" then
      scan.watchdog = nil
      abortScan("no_response")
    end
  end)
  return true
end

frame = CreateFrame("Frame")
-- The 1.60 client publishes the replicate copy through its own event. The
-- browse signals stay registered as fallbacks and as the player-search
-- signal; item searches publish NEW_RESULTS_RECEIVED with an itemKey.
frame:RegisterEvent("AUCTION_HOUSE_SHOW")
frame:RegisterEvent("REPLICATE_ITEM_LIST_UPDATE")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_ADDED")
frame:RegisterEvent("AUCTION_HOUSE_NEW_RESULTS_RECEIVED")
frame:RegisterEvent("AUCTION_HOUSE_BROWSE_FAILURE")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")
-- The owned-auction response is asynchronous; keep the fallback snapshot
-- fresh whenever the client publishes one.
frame:RegisterEvent("OWNED_AUCTIONS_UPDATED")

local function markPlayerSearch()
  searchQuietUntil = time() + SEARCH_QUIET_SECONDS
  if scan then scan.searchSeen = true end
end

frame:SetScript("OnEvent", function(_, event, payload)
  if event == "AUCTION_HOUSE_SHOW" then
    WAH.ahOpen = true
    refreshOwnedSnapshot()
    return
  end
  if event == "OWNED_AUCTIONS_UPDATED" then
    -- A scan in flight must keep the snapshot it started with; rebuilding
    -- mid-scan would attribute rows against a list that moved underneath.
    if not scan then captureOwnedSnapshot() end
    return
  end
  if event == "AUCTION_HOUSE_CLOSED" then
    WAH.ahOpen = false
    -- The row phase still reads the client's copy, which a closed house may
    -- clear; the finish phase works on tables this addon owns, so it must
    -- run to completion rather than discard a response already in hand.
    if scan and (scan.phase == "waiting" or scan.phase == "rows") then
      abortScan("ah_closed")
    end
    return
  end
  if event == "AUCTION_HOUSE_BROWSE_FAILURE" then
    if scan and scan.phase == "waiting" then abortScan("browse_failure") end
    return
  end
  if event == "REPLICATE_ITEM_LIST_UPDATE" then
    if scan and scan.phase == "waiting" then acceptReplicate("replicate") end
    return
  end
  -- A NEW_RESULTS_RECEIVED with an itemKey belongs to an item search. Let
  -- it through only as a "the player is using the AH" signal; the scan
  -- itself only accepts the nil-payload form.
  if event == "AUCTION_HOUSE_NEW_RESULTS_RECEIVED" and payload ~= nil then
    markPlayerSearch()
    return
  end
  if scan and scan.phase == "waiting" and not scan.searchSeen then
    acceptReplicate("fallback")
  end
end)

-- Auto-rescan: while the AH stays open, replicate again once the scan
-- interval elapses. Player searches pause the ticker so an automatic copy
-- never overwrites the results the player is reading.
C_Timer.NewTicker(20, function()
  if not autoScanOn() or scan then return end
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
  return historyWindowForPhase(WAH.currentPhase())
end

-- Sample count only. The decision core never reads point tables, so a
-- radar refresh must not build one table per history point per item.
-- New scans stamp the same count on the item record; this is the fallback
-- for a scan written before the stamp existed.
function WAH.historySamples(itemId)
  local market = WAH.seriesMarket()
  return seriesSamples(market and market.items[itemId], time(), historyWindowHours())
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

-- Sell-page price x duration search. On by default; off posts the plain
-- one-copper undercut at the selected duration.
-- Cross-character moves. The client's mail has no reliable "this is a
-- transfer" signal (an attachment is an attachment), so the move is
-- manual: record it on the sender with `out`, note the printed cost, and
-- record it on the receiver with `in <unit cost>`. Recording it on one side
-- only is worse than not recording it: the books would disagree.
-- Vendor sales have no per-item client event (the sales UI reports a
-- localized summary line, not a fact this addon can attribute). The plan
-- is to record nothing automatically rather than guess; this command is
-- the manual path the ledger actually uses.
SLASH_WOWDERHOIAHCOST1 = "/wahcost"
SlashCmdList["WOWDERHOIAHCOST"] = function(input)
  local itemId, quantity, paid = (input or ""):match("^%s*(%d+)%s+(%d+)%s+(%d+)%s*$")
  itemId, quantity, paid = tonumber(itemId), tonumber(quantity), tonumber(paid)
  if not itemId or not quantity or quantity <= 0 or not paid then
    chatMessage(L.COST_USAGE)
    return
  end
  WAH.recordEvent({ k = "vendor", itemId = itemId, qty = quantity, paid = paid })
  chatMessage(string.format(L.COST_RECORDED, quantity, itemId, WAH.coinString(paid)))
end

SLASH_WOWDERHOIAHTRANSFER1 = "/wahtransfer"
SlashCmdList["WOWDERHOIAHTRANSFER"] = function(input)
  local itemId, quantity, direction, unitCost = (input or "")
    :match("^%s*(%d+)%s+(%d+)%s*(%a+)%s*(%d*)%s*$")
  itemId, quantity = tonumber(itemId), tonumber(quantity)
  if not itemId or not quantity or quantity <= 0
    or (direction ~= "out" and direction ~= "in") then
    chatMessage(L.TRANSFER_USAGE)
    return
  end
  local ledger = WAH.Ledger and WAH.Ledger.current()
  if direction == "out" then
    local position = ledger and ledger.positions and ledger.positions[itemId]
    local average = position and position.qty and position.qty > 0
      and position.cost / position.qty or 0
    if not position then
      chatMessage(L.TRANSFER_NO_POSITION)
      return
    end
    WAH.recordEvent({ k = "transfer_out", itemId = itemId, qty = quantity,
      cost = math.floor(average * quantity + 0.5) })
    chatMessage(string.format(L.TRANSFER_OUT, quantity, itemId, WAH.coinString(math.floor(average + 0.5))))
  else
    local unit = tonumber(unitCost) or 0
    WAH.recordEvent({ k = "transfer_in", itemId = itemId, qty = quantity,
      cost = unit * quantity })
    chatMessage(string.format(L.TRANSFER_IN, quantity, itemId, WAH.coinString(unit)))
  end
end

SLASH_WOWDERHOIAHPRICING1 = "/wahpricing"
SlashCmdList["WOWDERHOIAHPRICING"] = function(input)
  local state = (input or ""):lower():match("^%s*(%S*)%s*$")
  if state ~= "" and state ~= "on" and state ~= "off" then
    chatMessage(L.PRICING_USAGE)
    return
  end
  local enabled = state ~= "off"
  WAH.settings.pricing = enabled
  chatMessage(string.format(L.PRICING_SET, enabled and "on" or "off"))
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
      -- The scan stamped the window count while it held the series; a
      -- refresh reads one number instead of walking every item's points.
      -- Older scans in the same session fall back to the live count.
      local samples = entry.historySamples or WAH.historySamples(itemId)
      local own = ownSales[itemId]
      -- The key is the item's identity: Core.evaluate iterates pairs(items)
      -- and never reads an id field from the record.
      input.market.items[itemId] = {
        name = entry.name,
        quality = entry.quality,
        itemClass = entry.itemClass,
        itemSubClass = entry.itemSubClass,
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
        ownerVisible = entry.ownerVisible,
        sellerHHI = entry.sellerHHI,
        topSellerShare = entry.topSellerShare,
        bidOnly = entry.bidOnly,
        highestBid = entry.highestBid,
        tiers = entry.tiers,
        tierTruncated = entry.tierTruncated,
        inferredSoldLow = entry.inferredSoldLow,
        inferredSoldHigh = entry.inferredSoldHigh,
        -- False when this scan had no baseline for the item; the core treats
        -- the zero interval as missing data instead of an observed zero.
        flowObserved = entry.flowObserved,
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
