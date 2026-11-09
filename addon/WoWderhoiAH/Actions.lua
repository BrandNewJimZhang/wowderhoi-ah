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
local function journalHas(kind, auctionID)
  if auctionID == nil then return false end
  local events = WAH.Journal and WAH.Journal.current() or {}
  local floor = math.max(1, #events - 200)
  for index = #events, floor, -1 do
    local event = events[index]
    if event.k == kind and sameID(event.auctionID, auctionID) then return true end
  end
  return false
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
  if journalHas("post", auctionID) then return false end
  local data = pending
  if data then
    data.recorded = true
  else
    local resolved = Actions.resolveAuction(auctionID)
    if not resolved then return false end
    data = { itemId = resolved.itemId, qty = resolved.quantity, price = resolved.unitPrice }
  end
  WAH.recordEvent({
    k = "post",
    auctionID = auctionID,
    itemId = data.itemId,
    qty = data.qty or data.quantity or 0,
    price = data.price or data.unitPrice or 0,
    -- A native posting does not expose the deposit; the cash reconciler
    -- reports the resulting drift instead of inventing a number.
    deposit = data.deposit or 0,
    depositUnknown = (pending == nil) and true or nil
  })
  return true
end

function Actions.purchase(auctionID, pending)
  if pending and pending.recorded then return false end
  if journalHas("buy", auctionID) then return false end
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
    return false
  end
  local cost = pending and pending.cost
  local priceSource = "request"
  if not cost then
    cost = Actions.estimateCommodityCost(itemId, quantity) or 0
    priceSource = "estimated"
  end
  lastCommodity = { itemId = itemId, qty = quantity, at = now }
  if pending then pending.recorded = true end
  WAH.recordEvent({
    k = "buy",
    itemId = itemId,
    qty = quantity,
    cost = cost,
    priceSource = priceSource
  })
  return true
end

function Actions.cancel(auctionID, pending)
  if auctionID == nil then return false end
  if pending and pending.recorded then return false end
  if journalHas("cancel", auctionID) then return false end
  if pending then pending.recorded = true end
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
  if journalHas("expire", auctionID) then return false end
  WAH.recordEvent({ k = "expire", auctionID = auctionID })
  return true
end

function Actions.bid(auctionID, amount)
  if auctionID == nil then return false end
  if journalHas("bid", auctionID) then return false end
  WAH.recordEvent({ k = "bid", auctionID = auctionID, amount = amount or 0 })
  return true
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("AUCTION_HOUSE_AUCTION_CREATED")
frame:RegisterEvent("AUCTION_CANCELED")
frame:RegisterEvent("AUCTION_HOUSE_AUCTION_CANCELED")
frame:RegisterEvent("AUCTION_HOUSE_AUCTIONS_EXPIRED")
frame:RegisterEvent("AUCTION_HOUSE_PURCHASE_COMPLETED")
frame:RegisterEvent("COMMODITY_PURCHASED")
frame:RegisterEvent("AUCTION_HOUSE_NEW_BID_RECEIVED")
frame:RegisterEvent("BID_ADDED")
frame:RegisterEvent("BIDS_UPDATED")

frame:SetScript("OnEvent", function(_, event, payload, extra)
  if event == "AUCTION_HOUSE_AUCTION_CREATED" then
    Actions.post(payload)
    return
  end
  if event == "AUCTION_CANCELED" or event == "AUCTION_HOUSE_AUCTION_CANCELED" then
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
    Actions.bid(payload, extra)
    return
  end
  -- BID_ADDED / BIDS_UPDATED name the auction in different builds; the
  -- auctionID is the first argument where the client supplies one.
  if event == "BID_ADDED" or event == "BIDS_UPDATED" then
    Actions.bid(payload, extra)
    return
  end
end)

WAH.Actions = Actions
