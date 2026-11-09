-- Auction-house action capture. The client broadcasts every auction action,
-- not just the ones this addon starts: a purchase, a posting, a cancellation
-- and an expiry are facts whichever UI produced them. The old handlers were
-- gated on a local pending request, so a player using the Blizzard UI wrote
-- nothing while the bag and the ledger drifted apart.
--
-- This module owns the journal writes for those events. The UI callers may
-- pass their richer pending record (deposit, requested quantity); without
-- one the event payload is resolved against the client's auction info and
-- the owned list. Duplicate events are collapsed by (kind, auctionID).

local ADDON_NAME, WAH = ...

local Actions = {}

local function sameID(left, right)
  return left ~= nil and right ~= nil and tostring(left) == tostring(right)
end

-- Recent events are enough: the client fires a completion event once, and
-- the UI path that also records it runs within the same action.
local function journalEvent(kind, auctionID)
  if auctionID == nil then return nil end
  local events = WAH.Journal and WAH.Journal.current() or {}
  local floor = math.max(1, #events - 200)
  for index = #events, floor, -1 do
    local event = events[index]
    if event.k == kind and sameID(event.auctionID, auctionID) then return event end
  end
  return nil
end

-- The native event only knows the auctionID; the UI's pending record knows
-- the deposit and the price the player actually paid. Whichever handler
-- runs first, the richer record must win instead of being dropped as a
-- duplicate. The fact is already in the book, so this upgrades it in place
-- and rebuilds the projection.
local function upgrade(event, patch)
  if not event then return false end
  local changed = false
  for key, value in pairs(patch) do
    if value ~= nil and event[key] ~= value then
      event[key] = value
      changed = true
    end
  end
  if changed then
    -- The sequence did not move, so the revision must: the watcher only
    -- uploads a book whose token changed, and the correction has to reach
    -- the terminal's append-only facts.
    if WAH.Journal and WAH.Journal.touch then WAH.Journal.touch() end
    if WAH.Ledger then WAH.Ledger.rebuild() end
    if WAH.Reconciler and WAH.Reconciler.publish then WAH.Reconciler.publish() end
    if WAH.requestFlush then WAH.requestFlush() end
  end
  return changed
end

local function round(value) return math.floor((value or 0) + 0.5) end

-- Resolve an auctionID to the item and quantity the client currently knows.
-- The owned list is the fallback: GetAuctionInfoByID is not guaranteed after
-- the purchase has settled.
function Actions.resolveAuction(auctionID)
  if auctionID == nil then return nil end
  if C_AuctionHouse and C_AuctionHouse.GetAuctionInfoByID then
    local info = C_AuctionHouse.GetAuctionInfoByID(auctionID)
    local itemId = info and info.itemKey and info.itemKey.itemID
    if itemId then
      local quantity = info.quantity or 1
      local total = info.buyoutAmount or info.bidAmount or 0
      return {
        itemId = itemId,
        quantity = quantity,
        total = total,
        unitPrice = quantity > 0 and round(total / quantity) or total
      }
    end
  end
  for _, row in ipairs(WAH.ownedAuctions and WAH.ownedAuctions() or {}) do
    if sameID(row.auctionID, auctionID) then
      local quantity = row.quantity or 1
      return {
        itemId = row.itemId,
        quantity = quantity,
        total = row.buyout or 0,
        unitPrice = quantity > 0 and round((row.buyout or 0) / quantity) or 0
      }
    end
  end
  return nil
end

-- What the client's current commodity search says the next units cost. A
-- native purchase has no local quote, so this is the only estimate the
-- ledger can record; it is labelled `estimated`.
function Actions.estimateCommodityCost(itemId, quantity)
  if not (C_AuctionHouse and C_AuctionHouse.GetNumCommoditySearchResults
    and C_AuctionHouse.GetCommoditySearchResultInfo) then
    return nil
  end
  local tiers = {}
  local count = C_AuctionHouse.GetNumCommoditySearchResults(itemId) or 0
  for index = 1, count do
    local info = C_AuctionHouse.GetCommoditySearchResultInfo(itemId, index)
    if info and info.unitPrice then
      tiers[#tiers + 1] = { p = info.unitPrice, q = info.quantity or info.count or 1 }
    end
  end
  return WAH.Core and WAH.Core.ladderCost(tiers, quantity) or nil
end

function Actions.post(auctionID, pending)
  if auctionID == nil then return false end
  if pending and pending.recorded then return false end
  local data = pending
  if data then
    data.recorded = true
  else
    data = Actions.resolveAuction(auctionID)
    if not data then return false end
  end
  local existing = journalEvent("post", auctionID)
  if existing then
    upgrade(existing, {
      itemId = data.itemId,
      qty = data.qty or data.quantity,
      price = data.price or data.unitPrice,
      deposit = data.deposit
    })
    return false
  end
  WAH.recordEvent({
    k = "post",
    auctionID = auctionID,
    itemId = data.itemId,
    qty = data.qty or data.quantity or 0,
    price = data.price or data.unitPrice or 0,
    -- A native posting does not expose the deposit; the cash reconciler
    -- reports the resulting drift instead of inventing a number.
    deposit = data.deposit or 0
  })
  return true
end

function Actions.purchase(auctionID, pending)
  if pending and pending.recorded then return false end
  local data = pending
  if data then
    data.recorded = true
  elseif auctionID ~= nil then
    local resolved = Actions.resolveAuction(auctionID)
    if not resolved or resolved.total <= 0 then return false end
    data = {
      itemId = resolved.itemId,
      qty = resolved.quantity,
      cost = resolved.total,
      auctionID = auctionID
    }
  else
    return false
  end
  local existing = journalEvent("buy", auctionID)
  if existing then
    upgrade(existing, {
      itemId = data.itemId,
      qty = data.qty or data.quantity,
      -- A missing UI cost is unknown, not zero; never downgrade the
      -- event-resolved total to it.
      cost = data.cost and data.cost > 0 and data.cost or nil,
      priceSource = pending and "request" or nil
    })
    return false
  end
  WAH.recordEvent({
    k = "buy",
    auctionID = data.auctionID or auctionID,
    itemId = data.itemId,
    qty = data.qty or data.quantity or 1,
    cost = data.cost or 0,
    priceSource = data.priceSource or (pending and "request" or "event")
  })
  return true
end

-- A commodity fill has no auctionID, and both the action frame and the
-- trade page observe the same COMMODITY_PURCHASED event. Collapse the pair
-- by item and quantity inside one second; a genuinely new purchase of the
-- same size is a separate event later.
local lastCommodity = nil

function Actions.commodityPurchase(itemId, quantity, pending)
  if not itemId or not quantity or quantity <= 0 then return false end
  if pending and pending.recorded then return false end
  local now = time()
  if lastCommodity and lastCommodity.itemId == itemId and lastCommodity.qty == quantity
    and now - lastCommodity.at <= 1 then
    -- The event frame may have booked the fill with an estimate before the
    -- purchase path supplied the exact cost. Upgrade the same fact.
    if pending and pending.cost and not pending.recorded then
      pending.recorded = true
      upgrade(lastCommodity.event, { cost = pending.cost, priceSource = "request" })
    end
    return false
  end
  local cost = pending and pending.cost
  local priceSource = "request"
  if not cost then
    cost = Actions.estimateCommodityCost(itemId, quantity) or 0
    priceSource = "estimated"
  end
  if pending then pending.recorded = true end
  local event = WAH.recordEvent({
    k = "buy",
    itemId = itemId,
    qty = quantity,
    cost = cost,
    priceSource = priceSource
  })
  lastCommodity = { itemId = itemId, qty = quantity, at = now, event = event }
  return true
end

function Actions.cancel(auctionID, pending)
  if auctionID == nil then return false end
  if pending and pending.recorded then return false end
  if pending then pending.recorded = true end
  local existing = journalEvent("cancel", auctionID)
  if existing then
    upgrade(existing, {
      refund = pending and pending.refund,
      lostDeposit = pending and pending.lostDeposit
    })
    return false
  end
  WAH.recordEvent({
    k = "cancel",
    auctionID = auctionID,
    refund = pending and pending.refund or nil,
    lostDeposit = pending and pending.lostDeposit or nil
  })
  return true
end

function Actions.expire(auctionID)
  if auctionID == nil then return false end
  if journalEvent("expire", auctionID) then return false end
  WAH.recordEvent({ k = "expire", auctionID = auctionID })
  return true
end

function Actions.bid(auctionID)
  -- Some builds publish a table for BIDS_UPDATED; a table is not an
  -- auction identity and cannot be deduplicated.
  if type(auctionID) ~= "number" and type(auctionID) ~= "string" then return false end
  if journalEvent("bid", auctionID) then return false end
  -- The ledger does not need the amount: a bid freezes cash and consumes
  -- nothing, and the winning mail books the cost. The identity is what
  -- keeps a repeated event from writing twice.
  WAH.recordEvent({ k = "bid", auctionID = auctionID })
  return true
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("AUCTION_HOUSE_AUCTION_CREATED")
frame:RegisterEvent("AUCTION_CANCELED")
frame:RegisterEvent("AUCTION_HOUSE_AUCTIONS_EXPIRED")
frame:RegisterEvent("AUCTION_HOUSE_PURCHASE_COMPLETED")
frame:RegisterEvent("COMMODITY_PURCHASED")
-- BID_ADDED names the bid, not the auction (BIDS_UPDATED has no payload),
-- so it cannot be deduplicated against an auction identity. The received-bid
-- event carries the auctionID and is the only one this module can book.
frame:RegisterEvent("AUCTION_HOUSE_NEW_BID_RECEIVED")

frame:SetScript("OnEvent", function(_, event, payload, extra)
  if event == "AUCTION_HOUSE_AUCTION_CREATED" then
    Actions.post(payload)
    return
  end
  if event == "AUCTION_CANCELED" then
    Actions.cancel(payload)
    return
  end
  if event == "AUCTION_HOUSE_AUCTIONS_EXPIRED" then
    Actions.expire(payload)
    return
  end
  if event == "AUCTION_HOUSE_PURCHASE_COMPLETED" then
    Actions.purchase(payload)
    return
  end
  if event == "COMMODITY_PURCHASED" then
    Actions.commodityPurchase(payload, extra)
    return
  end
  if event == "AUCTION_HOUSE_NEW_BID_RECEIVED" then
    Actions.bid(payload)
    return
  end
end)

WAH.Actions = Actions
