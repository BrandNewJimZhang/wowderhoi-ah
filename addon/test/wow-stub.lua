-- Test-only WoW client stub. Loaded before addon/WoWderhoiAH/*.lua so the
-- real addon files can run unmodified inside a bare Lua VM.
--
-- Every frame is one permissive mock: the handful of calls a test can
-- observe (SetText, SetScript, SetAllPoints, Show/Hide) are implemented,
-- and every layout or appearance setter falls through to a no-op, because
-- anchors and colors have no observable behavior outside a real client.
-- Mock state is stored under _-prefixed keys so it can never collide with
-- the fields the addon hangs on its own frames (trade.rows, row.name, ...).
--
-- This stub models the WoW Forever (1.60.1) client: the modern
-- C_AuctionHouse API, AuctionHouseFrame, and no legacy
-- QueryAuctionItems/GetAuctionItemInfo surface. A test that reaches for a
-- legacy function fails loudly instead of passing on a client that no
-- longer exists.
--
-- Ceiling: fengari is Lua 5.3 while the client is 5.1. For this addon's
-- arithmetic that difference is conservative -- 5.3 is the stricter of the
-- two about string.format("%d", <float>) and integer division -- so code
-- passing here passes there. Upgrade path if integer-sensitive code ever
-- lands: run the same stub under a real 5.1 binary.

local bed = { chat = {}, frames = {}, timers = {}, tickers = {}, hooks = {}, listings = {}, itemInfo = {}, ns = {} }
WowTest = bed

local NOW = 1700000000 -- fixed clock; real time() would make history windows flaky
local clockOffset = 0
-- Work the scanner does per client call, in milliseconds. Zero by default so
-- the per-frame budget never trips; a test that needs a long scan turns it on
-- and simulates the client spending real time on rows.
local stepCostMs = 0
local profilerMs = 0

function debugprofilestop()
  local value = profilerMs
  profilerMs = profilerMs + stepCostMs
  return value
end

function bed.setFrameCost(ms) stepCostMs = ms end

-- Advance the wall clock and run everything that became due: timers first,
-- then ticker intervals. Callbacks may schedule more work, so the loop runs
-- until nothing else is due.
function bed.advance(seconds)
  clockOffset = clockOffset + (seconds or 0)
  local target = NOW + clockOffset
  local guard = 0
  while guard < 10000 do
    guard = guard + 1
    local earliest, earliestIndex
    for index, entry in ipairs(bed.timers) do
      if not entry.cancelled and (not earliest or entry.due < earliest.due) then
        earliest, earliestIndex = entry, index
      end
    end
    local tickerDue
    for _, ticker in ipairs(bed.tickers) do
      if not ticker.cancelled and ticker.nextAt <= target
        and (not tickerDue or ticker.nextAt < tickerDue.nextAt) then
        tickerDue = ticker
      end
    end
    local timerDue = earliest and earliest.due <= target and earliest or nil
    if not timerDue and not tickerDue then break end
    if timerDue and (not tickerDue or timerDue.due <= tickerDue.nextAt) then
      table.remove(bed.timers, earliestIndex)
      if not timerDue.cancelled then timerDue.callback() end
    else
      tickerDue.nextAt = tickerDue.nextAt + tickerDue.interval
      tickerDue.callback()
    end
  end
end

local function noop() end

local frameMeta = {}
frameMeta.__index = frameMeta
-- Any frame method this stub does not implement is layout, so it no-ops.
-- The fallback is restricted to PascalCase keys because WoW frame methods
-- are all PascalCase while frame *fields* are not: returning a function for
-- an unset field would turn every `frame.thing or default` into a function.
setmetatable(frameMeta, { __index = function(_, key)
  if type(key) == "string" and key:match("^%u") then return noop end
  return nil
end })

local function newFrame(frameName, parent)
  local frame = setmetatable({ _scripts = {}, _events = {}, _shown = false, _name = frameName, _parent = parent }, frameMeta)
  bed.frames[#bed.frames + 1] = frame
  if frameName then _G[frameName] = frame end
  return frame
end

function frameMeta:Show() self._shown = true end
-- The client fires OnHide when a shown frame goes away; GUI.lua's chart
-- lifecycle depends on that transition.
function frameMeta:Hide()
  local wasShown = self._shown
  self._shown = false
  if wasShown and self._scripts.OnHide then self._scripts.OnHide(self) end
end
function frameMeta:IsShown() return self._shown end
function frameMeta:SetScript(script, handler) self._scripts[script] = handler end
function frameMeta:HasScript() return true end
function frameMeta:HookScript(script, handler)
  local existing = self._scripts[script]
  self._scripts[script] = function(...)
    if existing then existing(...) end
    handler(...)
  end
end
function frameMeta:RegisterEvent(event) self._events[event] = true end
function frameMeta:SetText(text) self._text = text end
function frameMeta:GetText() return self._text or "" end
function frameMeta:SetAllPoints(target) self._allPoints = target end
function frameMeta:SetSize(width, height) self._width, self._height = width, height end
function frameMeta:SetWidth(width) self._width = width end
function frameMeta:SetHeight(height) self._height = height end
function frameMeta:GetHeight() return self._height end
function frameMeta:SetWordWrap(wrap) self._wordWrap = wrap end
function frameMeta:EnableMouse(enabled) self._mouse = enabled end
function frameMeta:SetBackdrop(backdrop) self._backdrop = backdrop end
function frameMeta:SetClampedToScreen(clamped) self._clamped = clamped end

-- SetPoint has three shapes in the real API. Normalizing them here is what
-- lets a test resolve where a frame actually lands, which is the only way
-- to assert that the panel's content stays off its own border art.
function frameMeta:SetPoint(point, first, second, third, fourth)
  local relativeTo, relativePoint, xOffset, yOffset
  if type(first) == "table" then
    relativeTo, relativePoint, xOffset, yOffset = first, second, third, fourth
  else
    relativeTo, relativePoint, xOffset, yOffset = self._parent, point, first, second
  end
  self._points = self._points or {}
  self._points[point] = {
    to = relativeTo, toPoint = relativePoint or point, x = xOffset or 0, y = yOffset or 0
  }
end
function frameMeta:CreateFontString() return newFrame(nil, self) end
function frameMeta:CreateTexture() return newFrame(nil, self) end
function frameMeta:CreateLine() return newFrame(nil, self) end
function frameMeta:SetChecked(checked) self._checked = checked end
function frameMeta:GetChecked() return self._checked end
function frameMeta:SetTextColor(red, green, blue) self._color = { red, green, blue } end

-- ============================== WoW globals ===========================

function CreateFrame(kind, frameName, parent, template)
  local frame = newFrame(frameName, parent)
  frame._kind, frame._template = kind, template
  -- InterfaceOptionsCheckButtonTemplate ships a Text font string; the
  -- settings panel writes its label through it.
  if kind == "CheckButton" then frame.Text = newFrame(nil, frame) end
  return frame
end

-- The 1.60 client ships the modern auction house frame; this is what the
-- addon anchors its panel to and what AUCTION_HOUSE_SHOW shows.
AuctionHouseFrame = newFrame("AuctionHouseFrame")
AuctionHouseFrame:SetSize(1000, 700)
AuctionHouseFrame:Show()
UIParent = newFrame("UIParent")
-- Item tooltip frames: GameTooltip and the client's embedded
-- GameTooltipTooltip both render lines, and the modern post-call can name
-- either one. Both get the same line API so a test reads whichever frame
-- the client actually used.
local function installTooltip(frame)
  frame._lines = {}
  function frame:SetOwner() end
  function frame:GetItem() return self._itemName, self._link end
  function frame:AddLine(text) self._lines[#self._lines + 1] = bed.plain(text) end
  function frame:AddDoubleLine(left, right)
    self._lines[#self._lines + 1] = bed.plain(left) .. "\t" .. bed.plain(right)
  end
  function frame:ClearLines()
    self._lines, self._source, self._link, self._itemName = {}, nil, nil, nil
    self.processingInfo = nil
    if self._scripts.OnTooltipCleared then self._scripts.OnTooltipCleared(self) end
  end
  return frame
end

GameTooltip = installTooltip(newFrame("GameTooltip"))
ItemRefTooltip = installTooltip(newFrame("ItemRefTooltip"))
GameTooltipTooltip = installTooltip(newFrame("GameTooltipTooltip"))

-- The 1.60 client renders item tooltips from typed data and posts the result
-- to the frame that owns the lines. TooltipUtil is the client accessor that
-- resolves the displayed item for any of those frames, and processingInfo
-- names the getter that produced them.
TooltipUtil = {
  GetDisplayedItem = function(tooltip) return tooltip._itemName, tooltip._link end
}
TooltipDataProcessor = {
  _postCalls = {},
  AddTooltipPostCall = function(dataType, handler)
    table.insert(TooltipDataProcessor._postCalls, { dataType = dataType, handler = handler })
  end
}
function bed.fireTooltipPost(dataType, tooltip, data)
  for _, call in ipairs(TooltipDataProcessor._postCalls) do
    if call.dataType == dataType then call.handler(tooltip, data or {}) end
  end
end

-- A hover the client resolves itself (the embedded tooltip, a clicked chat
-- link) reaches the addon only through this post-call.
function bed.fireItemTooltip(tooltip, link, itemName)
  tooltip:ClearLines()
  tooltip._link, tooltip._itemName = link, itemName
  bed.fireTooltipPost(Enum.TooltipDataType.Item, tooltip)
end

-- The hook fallback only exists for pre-10.0.2 clients. Dropping the modern
-- globals before the addon files load makes that branch the shipped path.
function bed.useLegacyTooltips()
  TooltipDataProcessor = nil
  TooltipUtil = nil
  GameTooltipTooltip = nil
end

local function tooltipShowItem(tooltip, source, itemId, itemName)
  tooltip:ClearLines()
  tooltip._source, tooltip._itemName = source, itemName
  tooltip._link = "|Hitem:" .. tostring(itemId) .. ":0:0:0|h[" .. tostring(itemName) .. "]|h"
  tooltip:Show()
end

-- Bag contents are seeded by a test; the slot number is what the client's
-- bag buttons pass, so the tooltip source names the slot a player hovered.
bed.bagItems = {}
function GameTooltip:SetBagItem(bag, slot)
  local item = bed.bagItems[slot]
  if not item then error("no bag item at slot " .. tostring(slot)) end
  tooltipShowItem(self, "bag:" .. tostring(slot), item.itemId, item.name)
  if TooltipDataProcessor then
    self.processingInfo = { getterName = "GetBagItem", getterArgs = { bag, slot } }
    bed.fireTooltipPost(Enum.TooltipDataType.Item, self)
  end
end

function GameTooltip:SetHyperlink(link)
  local text = tostring(link)
  -- Only an anchored item hyperlink produces item tooltip data. A string
  -- that merely contains "item:" is not one, exactly like the client.
  local itemId = text:match("^item:(%d+)")
    or text:match("^|Hitem:(%d+)")
    or text:match("^|c%x%x%x%x%x%x%x%x|Hitem:(%d+)")
  if itemId then
    tooltipShowItem(self, "hyperlink:" .. text, tonumber(itemId), link)
    if TooltipDataProcessor then
      self.processingInfo = { getterName = "GetHyperlink", getterArgs = { text } }
      bed.fireTooltipPost(Enum.TooltipDataType.Item, self)
    end
    return
  end
  -- The client reuses one GameTooltip. A spell or unit hyperlink replaces
  -- the visible lines but not the item fields the last item left behind;
  -- that stale link is exactly what a tooltip hook must not trust.
  self._source = "hyperlink:" .. text
  self.processingInfo = nil
  self:Show()
end

DEFAULT_CHAT_FRAME = { AddMessage = function(_, text) bed.chat[#bed.chat + 1] = text end }
SlashCmdList = {}

function hooksecurefunc(target, name, handler)
  if type(target) == "string" then
    bed.hooks[target] = bed.hooks[target] or {}
    table.insert(bed.hooks[target], name)
    return
  end
  local original = target[name]
  target[name] = function(...)
    local result
    if original then result = original(...) end
    handler(...)
    return result
  end
end

-- C_Timer is called with a dot in this client (no implicit self): the first
-- argument is the delay or interval.
C_Timer = {
  After = function(delay, callback)
    bed.timers[#bed.timers + 1] = { due = time() + (delay or 0), callback = callback }
  end,
  NewTimer = function(delay, callback)
    local entry = { due = time() + (delay or 0), callback = callback }
    bed.timers[#bed.timers + 1] = entry
    return { Cancel = function() entry.cancelled = true end }
  end,
  NewTicker = function(interval, callback)
    local ticker = { interval = interval, nextAt = time() + interval, callback = callback }
    bed.tickers[#bed.tickers + 1] = ticker
    return { Cancel = function() ticker.cancelled = true end }
  end
}

function wipe(target)
  for key in pairs(target) do target[key] = nil end
  return target
end

function GetLocale() return bed.locale or "zhCN" end
function time() return NOW + clockOffset end
function date(format, when) return os.date(format, when or NOW) end
function GetRealmName() return "TestRealm" end
function UnitFactionGroup() return "Alliance" end
function UnitName() return "Tester" end
function GetMoney() return 1000000 end
function GetCursorInfo() return bed.cursorInfo and bed.cursorInfo[1], bed.cursorInfo and bed.cursorInfo[2] end

function FauxScrollFrame_GetOffset(frame) return frame._offset or 0 end
function FauxScrollFrame_SetOffset(frame, offset) frame._offset = offset end
function FauxScrollFrame_Update(frame, total) frame._total = total end
function FauxScrollFrame_OnVerticalScroll() end
function InterfaceOptions_AddCategory() end
function InterfaceOptionsFrame_OpenToCategory() end

-- Modern options panel registration. The addon prefers this path; the
-- legacy InterfaceOptions fallback only runs when Settings is absent.
Settings = {
  RegisterCanvasLayoutCategory = function(panel, name)
    return { GetID = function() return 1 end }
  end,
  RegisterAddOnCategory = function() end,
  OpenToCategory = function() end
}

-- Real signature: name, link, quality, iLevel, reqLevel, class, subClass,
-- maxStack, equipSlot, texture, vendorPrice. The addon reads 6, 7 and 11.
-- This is the C_Item namespace surface the 1.60 client documents; the legacy
-- GetItemInfo global is deliberately absent so the addon's shim is what runs.
C_Item = {
  GetItemInfo = function(itemId)
    bed.itemInfoCalls = (bed.itemInfoCalls or 0) + 1
    local info = bed.itemInfo[itemId] or {}
    return info.name, nil, info.quality, nil, nil, info.class or "Trade Goods", info.subClass or "Other",
      nil, nil, nil, info.vendorP or 0
  end,
  GetItemIconByID = function(itemId) return "icon:" .. tostring(itemId) end,
  RequestLoadItemDataByID = function(itemId)
    bed.requestedItemData = bed.requestedItemData or {}
    bed.requestedItemData[itemId] = true
  end
}

-- The client answers a lazy item-record request with ITEM_DATA_LOAD_RESULT.
-- Tests drive that event explicitly; the fixture may update bed.itemInfo
-- first so a successful answer also changes what GetItemInfo returns.
function bed.sendItemDataLoaded(itemId, success)
  bed.fireEvent("ITEM_DATA_LOAD_RESULT", itemId, success ~= false)
end

C_CurrencyInfo = {
  GetCoinTextureString = function(copper)
    return tostring(math.floor((copper or 0) + 0.5)) .. "c"
  end
}

-- The addon calls SaveAddOns after every scan so the desktop watcher sees
-- the news without waiting for a logout.
C_AddOns = {
  SaveAddOns = function() bed.savedCount = (bed.savedCount or 0) + 1 end
}

Enum = {
  AuctionHouseSortOrder = { Price = 0, Name = 1, Level = 2, Bid = 3, Buyout = 4, TimeRemaining = 5 },
  TooltipDataType = { Item = 0 },
  ItemCommodityStatus = { Unknown = 0, Item = 1, Commodity = 2 }
}

-- ====================== Modern auction house ==========================

local ah = {
  replicate = {}, -- array of { itemId, name, count, buyout, quality, minBid }
  itemKeys = {}, -- itemId -> ItemKeyInfo
  itemResults = {}, -- itemId -> array of ItemSearchResultInfo-shaped rows
  commodityResults = {}, -- itemId -> array of CommoditySearchResultInfo-shaped rows
  auctions = {}, -- auctionID -> AuctionInfo-shaped row
  browse = {} -- array of BrowseResultInfo-shaped rows
}
bed.ah = ah
bed.pendingItemResults = {}
bed.pendingCommodityResults = {}
bed.pendingBrowse = {}

local function keyFor(itemId)
  return { itemID = itemId, itemLevel = 0, itemSuffix = 0, battlePetSpeciesID = 0 }
end

C_AuctionHouse = {
  ReplicateItems = function() end,
  GetNumReplicateItems = function() return #ah.replicate end,
  GetReplicateItemInfo = function(index)
    local item = ah.replicate[index]
    if not item then return nil end
    -- name, texture, count, quality, usable, level, levelType, minBid,
    -- minIncrement, buyoutPrice, bidAmount, highBidder, bidderFullName,
    -- owner, ownerFullName, saleStatus, itemID, hasAllInfo
    local owner = item.owner
    if owner == nil and item.sellerUnknown ~= true then owner = "Owner" end
    return item.name, "texture", item.count, item.quality or 1, true, 1, "Item",
      item.minBid or 0, 0, item.buyout, item.bid or 0, item.highBidder, nil,
      owner, owner and (owner .. "-Realm") or nil, item.saleStatus or 0,
      item.itemId, item.hasAllInfo ~= false
  end,
  GetReplicateItemTimeLeft = function(index)
    local item = ah.replicate[index]
    return item and item.timeLeft or 3600
  end,
  MakeItemKey = function(itemId, itemLevel, itemSuffix, battlePetSpeciesID)
    return {
      itemID = itemId,
      itemLevel = itemLevel or 0,
      itemSuffix = itemSuffix or 0,
      battlePetSpeciesID = battlePetSpeciesID or 0
    }
  end,
  GetItemKeyInfo = function(itemKey)
    local info = itemKey and ah.itemKeys[itemKey.itemID]
    if not info and itemKey then
      info = { itemID = itemKey.itemID, isCommodity = bed.commodityItems and bed.commodityItems[itemKey.itemID] or false }
      ah.itemKeys[itemKey.itemID] = info
    end
    if info and info.isCommodity == nil then
      info.isCommodity = bed.commodityItems and bed.commodityItems[itemKey.itemID] or false
    end
    return info
  end,
  SendBrowseQuery = function()
    ah.browse = bed.pendingBrowse
    bed.fireEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")
  end,
  GetBrowseResults = function() return ah.browse end,
  SendSearchQuery = function(itemKey, sorts, separateOwnerItems)
    bed.searchQuery = { itemKey = itemKey, sorts = sorts, separateOwnerItems = separateOwnerItems }
    local info = ah.itemKeys[itemKey.itemID]
    if info and info.isCommodity then
      ah.commodityResults[itemKey.itemID] = bed.pendingCommodityResults[itemKey.itemID] or {}
    else
      ah.itemResults[itemKey.itemID] = bed.pendingItemResults[itemKey.itemID] or {}
    end
    bed.fireEvent("AUCTION_HOUSE_NEW_RESULTS_RECEIVED", itemKey)
  end,
  GetNumItemSearchResults = function(itemKey)
    return #(ah.itemResults[itemKey.itemID] or {})
  end,
  GetItemSearchResultInfo = function(itemKey, index)
    return (ah.itemResults[itemKey.itemID] or {})[index]
  end,
  HasFullItemSearchResults = function() return true end,
  RequestMoreItemSearchResults = function() return true end,
  GetNumCommoditySearchResults = function(itemId)
    return #(ah.commodityResults[itemId] or {})
  end,
  GetCommoditySearchResultInfo = function(itemId, index)
    return (ah.commodityResults[itemId] or {})[index]
  end,
  HasFullCommoditySearchResults = function() return true end,
  RequestMoreCommoditySearchResults = function() return true end,
  GetAuctionInfoByID = function(auctionID) return ah.auctions[auctionID] end,
  PlaceBid = function(auctionID, amount)
    bed.bid = { auctionID = auctionID, amount = amount }
  end,
  StartCommoditiesPurchase = function(itemId, quantity)
    bed.commodityPurchase = { itemId = itemId, quantity = quantity }
  end,
  ConfirmCommoditiesPurchase = function() end,
  IsThrottledMessageSystemReady = function() return true end
}


-- ===================== Sell side and owned auctions ===================

-- Bag fixtures: { bag, slot, itemId, count, name, commodity }.
bed.bagContents = {}
bed.bagSlots = {}
bed.commodityItems = {}
bed.ownedAuctions = {}
bed.lastAuctionID = 5000

function bed.setBag(items)
  bed.bagContents, bed.bagSlots, bed.commodityItems = {}, {}, {}
  for _, item in ipairs(items) do
    bed.bagContents[item.bag .. ":" .. item.slot] = {
      itemID = item.itemId,
      stackCount = item.count,
      itemName = item.name,
      iconFileID = 0,
      quality = item.quality or 1
    }
    bed.bagSlots[item.bag] = math.max(bed.bagSlots[item.bag] or 0, item.slot)
    if item.commodity then bed.commodityItems[item.itemId] = true end
  end
end

function bed.setOwned(rows)
  bed.ownedAuctions = {}
  for _, row in ipairs(rows) do
    bed.ownedAuctions[row.auctionID] = {
      auctionID = row.auctionID,
      itemKey = { itemID = row.itemId },
      quantity = row.quantity or 1,
      buyoutAmount = row.buyoutAmount or 0,
      timeLeftSeconds = row.timeLeftSeconds or 3600,
      status = 1
    }
  end
end

local function ownedList()
  local list = {}
  for _, row in pairs(bed.ownedAuctions) do list[#list + 1] = row end
  table.sort(list, function(left, right) return left.auctionID < right.auctionID end)
  return list
end

ItemLocation = {}
function ItemLocation:CreateFromBagAndSlot(bag, slot)
  return { bag = bag, slot = slot }
end

C_Container = {
  GetContainerNumSlots = function(bag) return bed.bagSlots[bag] or 0 end,
  GetContainerItemInfo = function(bag, slot) return bed.bagContents[bag .. ":" .. slot] end,
  -- The setter-argument accessor the addon uses to name a hovered bag item
  -- without trusting the tooltip's remembered item. Tooltip tests seed the
  -- slot fixture; scan tests seed the bag/slot fixture.
  GetContainerItemLink = function(bag, slot)
    local item = bed.bagItems[slot]
    local itemId, name = item and item.itemId, item and item.name
    if not itemId then
      local info = bed.bagContents[bag .. ":" .. slot]
      itemId, name = info and info.itemID, info and info.name
    end
    if not itemId then return nil end
    return "|Hitem:" .. tostring(itemId) .. ":0:0:0|h[" .. tostring(name or "item") .. "]|h"
  end,
  -- Free slots are a separate fixture. Without one the stub reports a
  -- single 20-slot backpack, the same planning capacity the old hardcoded
  -- constant used; `bed.freeBagSlots = {}` is an explicitly full client.
  GetContainerNumFreeSlots = function(bag)
    if bed.freeBagSlots then return bed.freeBagSlots[bag] or 0 end
    return bag == 0 and 20 or 0
  end
}

C_AuctionHouse.GetItemCommodityStatus = function(item)
  local info = item and bed.bagContents[item.bag .. ":" .. item.slot]
  if info and bed.commodityItems[info.itemID] then return Enum.ItemCommodityStatus.Commodity end
  return Enum.ItemCommodityStatus.Item
end

C_AuctionHouse.CalculateItemDeposit = function(item, duration, quantity)
  return (quantity or 1) * (duration or 24) * 2
end

C_AuctionHouse.CalculateCommodityDeposit = function(itemId, duration, quantity)
  return (quantity or 1) * (duration or 24) * 3
end

C_AuctionHouse.PostItem = function(item, duration, quantity, bid, buyout)
  local info = bed.bagContents[item.bag .. ":" .. item.slot]
  bed.posted = { itemId = info and info.itemID, duration = duration, quantity = quantity,
    bid = bid, buyout = buyout, commodity = false }
  bed.lastAuctionID = bed.lastAuctionID + 1
  bed.ownedAuctions[bed.lastAuctionID] = {
    auctionID = bed.lastAuctionID,
    itemKey = { itemID = info and info.itemID or 0 },
    quantity = quantity,
    buyoutAmount = buyout * quantity,
    timeLeftSeconds = duration * 3600,
    status = 1
  }
  bed.fireEvent("AUCTION_HOUSE_AUCTION_CREATED", bed.lastAuctionID)
  return false
end

C_AuctionHouse.PostCommodity = function(item, duration, quantity, unitPrice)
  local info = bed.bagContents[item.bag .. ":" .. item.slot]
  bed.posted = { itemId = info and info.itemID, duration = duration, quantity = quantity,
    unitPrice = unitPrice, commodity = true }
  bed.lastAuctionID = bed.lastAuctionID + 1
  bed.ownedAuctions[bed.lastAuctionID] = {
    auctionID = bed.lastAuctionID,
    itemKey = { itemID = info and info.itemID or 0 },
    quantity = quantity,
    buyoutAmount = unitPrice * quantity,
    timeLeftSeconds = duration * 3600,
    status = 1
  }
  bed.fireEvent("AUCTION_HOUSE_AUCTION_CREATED", bed.lastAuctionID)
  return false
end

C_AuctionHouse.ConfirmPostItem = function() end
C_AuctionHouse.ConfirmPostCommodity = function() end

C_AuctionHouse.GetTimeLeftBandInfo = function(band)
  return 0, ({ 1800, 7200, 43200, 172800 })[band + 1] or 172800
end

C_AuctionHouse.QueryOwnedAuctions = function()
  bed.fireEvent("OWNED_AUCTIONS_UPDATED")
end
C_AuctionHouse.GetNumOwnedAuctions = function() return #ownedList() end
C_AuctionHouse.GetOwnedAuctionInfo = function(index) return ownedList()[index] end
C_AuctionHouse.CanCancelAuction = function(auctionID) return bed.ownedAuctions[auctionID] ~= nil end
C_AuctionHouse.GetCancelCost = function(auctionID) return bed.cancelCost or 10 end
C_AuctionHouse.CancelAuction = function(auctionID)
  bed.ownedAuctions[auctionID] = nil
  bed.fireEvent("OWNED_AUCTIONS_UPDATED")
end

-- ============================== Mailbox ===============================

-- Fixtures: { sender, subject, money, hasItem, attachments = { "|Hitem:..|h" },
-- invoice = { kind, name, player, bid, buyout, deposit, consignment } }.
bed.mail = {}
bed.mailFrame = newFrame("MailFrame")
bed.mailFrame:Show()
MailFrame = bed.mailFrame

function bed.setMail(messages)
  bed.mail = messages or {}
end

function GetInboxNumItems() return #bed.mail end

function GetInboxHeaderInfo(index)
  local message = bed.mail[index]
  if not message then return end
  local attachments = message.attachments or {}
  return "Interface\\Icons\\INV_Letter", "Interface\\Stationery\\Test", message.sender or "Auction House",
    message.subject or "", message.money or 0, message.cod or 0, message.daysLeft or 30,
    message.hasItem == true, false, false, nil, false, #attachments
end

function GetInboxInvoiceInfo(index)
  local invoice = bed.mail[index] and bed.mail[index].invoice
  if not invoice then return end
  return invoice.kind, invoice.name, invoice.player, invoice.bid or 0, invoice.buyout or 0,
    invoice.deposit or 0, invoice.consignment or 0
end

function GetInboxItemLink(index, attachment)
  local message = bed.mail[index]
  return message and message.attachments and message.attachments[attachment]
end

C_Mail = {
  HasInboxMoney = function(index)
    return (bed.mail[index] and bed.mail[index].money or 0) > 0
  end,
  CanCheckInbox = function() return bed.canCheckInbox, 30 end
}

-- ============================== Crafting ==============================

-- The client reports the crafted item and quantity; recipe info lets the
-- addon map a recipe spell id to the dataset's recipe id.
bed.recipeInfo = {}

C_TradeSkillUI = {
  GetRecipeInfo = function(recipeSpellID) return bed.recipeInfo[recipeSpellID] end
}

-- ============================== Test bed ==============================

-- Strip WoW color escapes so assertions read as what the player sees.
function bed.plain(text)
  return (tostring(text or ""):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""))
end

local function tradeFrame()
  return _G.WoWderhoiAHTrade or error("trade frame not built -- call WowTest.openTab() first")
end

function bed.fireEvent(event, ...)
  -- The client hides the auction house frame on close; tests that search
  -- after an AUCTION_HOUSE_CLOSED must see the same gate a player would.
  if event == "AUCTION_HOUSE_SHOW" then AuctionHouseFrame:Show() end
  if event == "AUCTION_HOUSE_CLOSED" then AuctionHouseFrame:Hide() end
  for _, frame in ipairs(bed.frames) do
    if frame._events[event] and frame._scripts.OnEvent then
      frame._scripts.OnEvent(frame, event, ...)
    end
  end
end

-- Fire every pending timer now, regardless of its due time. The old stub
-- promised exactly this; tests that model a timer firing use advance()
-- instead, and tests that only need "the callback runs" keep this helper.
function bed.runTimers()
  local pending = bed.timers
  bed.timers = {}
  for _, entry in ipairs(pending) do
    if not entry.cancelled then entry.callback() end
  end
end

-- The replicate response has its own event in the 1.60 client. Browse
-- events are a fallback signal, not the acknowledgement itself.
function bed.fireReplicate()
  bed.fireEvent("REPLICATE_ITEM_LIST_UPDATE")
end

-- Wall-clock milliseconds a simulated frame takes. Non-zero values let a
-- test model a slow client: the scan keeps its OnUpdate loop but the world
-- clock moves as if frames were far apart.
function bed.tickFrames(count, frameMs)
  for _ = 1, count do
    for _, frame in ipairs(bed.frames) do
      local update = frame._scripts and frame._scripts.OnUpdate
      if update then update(frame) end
    end
    if frameMs and frameMs > 0 then bed.advance(frameMs / 1000) end
  end
end

function bed.clickButton(text)
  for _, frame in ipairs(bed.frames) do
    if frame._text == text and frame._scripts.OnClick then
      frame._scripts.OnClick(frame)
      return true
    end
  end
  error("no button labelled '" .. tostring(text) .. "'")
end

-- Header labels are FontStrings, which take no clicks; the button that does
-- is the one anchored over the label with SetAllPoints.
function bed.clickHeader(text)
  local trade = tradeFrame()
  local labels = { trade.headItem }
  for _, label in ipairs(trade.headers) do labels[#labels + 1] = label end
  for _, label in ipairs(labels) do
    if bed.plain(label._text):find(text, 1, true) == 1 then
      for _, frame in ipairs(bed.frames) do
        if frame._allPoints == label and frame._scripts.OnClick then
          frame._scripts.OnClick(frame)
          return true
        end
      end
      error("header '" .. text .. "' is not clickable")
    end
  end
  error("no header labelled '" .. text .. "'")
end

-- The client opens the auction house, the addon builds its standalone page
-- inside AUCTION_HOUSE_SHOW (or leaves it for /wahtrade when the setting is
-- off). openTab() replays the default path.
function bed.openTab()
  bed.fireEvent("AUCTION_HOUSE_SHOW")
  bed.runTimers()
  if not _G.WoWderhoiAHTrade then
    error("the WAH page was never built. Last chat: " .. bed.lastChat())
  end
end

-- Populate a replicate response and drive the scanner's OnUpdate loop to
-- completion. Items are { itemId, name, count, buyout, quality, vendorP }.
function bed.runScan(items)
  ah.replicate = {}
  for index, item in ipairs(items) do
    ah.replicate[index] = {
      itemId = item.itemId,
      name = item.name,
      count = item.count or 1,
      buyout = item.buyout or item.unitPrice or 0,
      quality = item.quality or 1,
      owner = item.owner,
      sellerUnknown = item.sellerUnknown,
      bid = item.bid,
      highBidder = item.highBidder,
      saleStatus = item.saleStatus,
      timeLeft = item.timeLeft
    }
    ah.itemKeys[item.itemId] = {
      itemID = item.itemId,
      itemName = item.name,
      isCommodity = item.commodity or false,
      iconFileID = 0,
      quality = item.quality or 1
    }
    if item.vendorP then
      bed.itemInfo[item.itemId] = bed.itemInfo[item.itemId] or {}
      bed.itemInfo[item.itemId].vendorP = item.vendorP
      bed.itemInfo[item.itemId].name = item.name
    end
  end
  local count = #items
  -- A fixture scan starts from a clean admission slate; admission itself is
  -- tested by driving requestScan directly.
  if WowTest.ns.settings then
    WowTest.ns.settings.lastReplicateAt = 0
    WowTest.ns.settings.retryAfter = 0
  end
  WowTest.ns.startScan()
  if not WowTest.ns.scanRunning then
    error("scan refused to start: " .. bed.lastChat())
  end
  bed.fireReplicate()
  local guard = 0
  while WowTest.ns.scanRunning and guard < 1000 do
    local ran = false
    for _, frame in ipairs(bed.frames) do
      local update = frame._scripts and frame._scripts.OnUpdate
      if update then
        update(frame)
        ran = true
      end
    end
    if not ran then break end
    guard = guard + 1
  end
  if WowTest.ns.scanRunning then
    error("scan did not finish after " .. guard .. " OnUpdate calls")
  end
  return count
end

function bed.setScan(items)
  local byId = {}
  for _, item in ipairs(items) do
    byId[item.itemId] = {
      name = item.name,
      quality = item.quality or 2,
      itemClass = item.itemClass,
      itemSubClass = item.itemSubClass,
      minPrice = item.minPrice,
      vendorP = item.vendorP or 0,
      sellP = item.sellP or item.minPrice,
      p5 = item.p5,
      marketPrice = item.marketPrice or item.minPrice,
      quantity = item.quantity or 0,
      numAuctions = item.numAuctions or 0,
      sellers = item.sellers or item.numAuctions or 0,
      sellersInvisible = item.sellersInvisible or false,
      bidOnly = item.bidOnly or 0,
      highestBid = item.highestBid or 0,
      tiers = item.tiers or { { p = item.minPrice, q = item.quantity or 1 } },
      expiring = item.expiring or { soon = 0, mid = 0, late = 0 },
      inferredSoldLow = item.inferredSoldLow or 0,
      inferredSoldHigh = item.inferredSoldHigh or 0,
      supplyGrowth = item.supplyGrowth or 0,
      elapsedHours = item.elapsedHours or 0.25
    }
  end
  WoWderhoiAH_ScanData = {
    dataVersion = bed.ns.PIPELINE_VERSION,
    scannedAt = NOW,
    server = "TestRealm",
    faction = "Alliance",
    character = "Tester",
    total = #items,
    items = byId
  }
  WoWderhoiAH_Series = {
    v = bed.ns.PIPELINE_VERSION,
    markets = {
      ["TestRealm|Alliance"] = { firstScanAt = NOW - 3600, items = {} }
    }
  }
end

-- closes are sell-front/P10 values oldest-first, one per scan, all inside
-- the 7d window. v4 stores the full point, not just a scalar close.
function bed.setPoints(entries)
  local series = { v = bed.ns.PIPELINE_VERSION, markets = {
    ["TestRealm|Alliance"] = { firstScanAt = NOW - 7 * 86400, items = {} }
  } }
  for _, entry in ipairs(entries) do
    -- Same parallel arrays the addon writes: t, min, sell, q, n, e.
    local point = { t = {}, min = {}, sell = {}, q = {}, n = {}, e = {} }
    -- Spacing is the fixture's coverage: a series that must satisfy a phase
    -- span floor passes a wider spacing than the default quarter hour.
    local spacing = entry.spacing or 900
    for index, close in ipairs(entry.closes) do
      point.t[index] = NOW - (#entry.closes - index) * spacing
      point.min[index], point.sell[index] = close, close
      point.q[index], point.n[index], point.e[index] = 100, 1, 0
    end
    series.markets["TestRealm|Alliance"].items[entry.itemId] = point
  end
  WoWderhoiAH_Series = series
end

-- Move a listing's price without re-running the search, so a test can make
-- the book change under a row the way another buyer would.
function bed.repriceListing(index, buyout)
  local listing = bed.listings[index]
  listing.buyout = buyout
  local auctionID = bed.auctionByIndex and bed.auctionByIndex[index]
  if auctionID and ah.auctions[auctionID] then
    ah.auctions[auctionID].buyoutAmount = buyout
  end
  if ah.itemResults[listing.itemId] then
    for _, row in ipairs(ah.itemResults[listing.itemId]) do
      if row.auctionID == auctionID then row.buyoutAmount = buyout end
    end
  end
end

-- Replay a typed search. The addon resolves the name against its own scan
-- first, then falls back to a browse query; this helper feeds both paths.
function bed.search(query, listings)
  bed.listings = listings
  bed.auctionByIndex = {}
  local first = listings[1]
  if not first then error("search needs at least one listing") end
  local commodity = first.commodity or false
  if commodity then
    local rows = {}
    for index, listing in ipairs(listings) do
      local auctionID = 1000 + index
      bed.auctionByIndex[index] = auctionID
      rows[index] = {
        itemID = listing.itemId,
        quantity = listing.count,
        unitPrice = listing.buyout / listing.count,
        auctionID = auctionID
      }
    end
    -- The server answers the Price sort in ascending order; the addon's
    -- commodity buy path reads result 1 as the market price.
    table.sort(rows, function(left, right) return left.unitPrice < right.unitPrice end)
    bed.pendingCommodityResults[first.itemId] = rows
  else
    local rows = {}
    for index, listing in ipairs(listings) do
      local auctionID = 1000 + index
      bed.auctionByIndex[index] = auctionID
      rows[index] = {
        itemKey = keyFor(listing.itemId),
        auctionID = auctionID,
        quantity = listing.count,
        itemLink = "|Hitem:" .. listing.itemId .. ":0:0:0|h[" .. listing.name .. "]|h",
        minBid = listing.buyout,
        buyoutAmount = listing.buyout
      }
      ah.auctions[auctionID] = {
        itemKey = keyFor(listing.itemId),
        itemLink = rows[index].itemLink,
        minBid = listing.buyout,
        bidAmount = listing.buyout,
        buyoutAmount = listing.buyout
      }
    end
    bed.pendingItemResults[first.itemId] = rows
  end
  ah.itemKeys[first.itemId] = {
    itemID = first.itemId,
    itemName = first.name,
    isCommodity = commodity,
    iconFileID = 0,
    quality = first.quality or 1
  }
  -- A name search that misses the scan uses the browse path; point it at
  -- the same item so both paths converge on one result set.
  bed.pendingBrowse = {
    {
      itemKey = keyFor(first.itemId),
      totalQuantity = 0,
      minPrice = first.buyout
    }
  }
  tradeFrame().searchBox:SetText(query)
  bed.clickButton(bed.ns.L.SEARCH)
end

function bed.rowCount()
  local count = 0
  for _, row in ipairs(tradeFrame().rows) do
    if row._shown then count = count + 1 end
  end
  return count
end

function bed.hoverRow(index, leave)
  local row = tradeFrame().rows[index]
  if not row._mouse then error("row " .. index .. " does not take mouse input") end
  local script = row._scripts[leave and "OnLeave" or "OnEnter"]
  if not script then error("row " .. index .. " has no hover handler") end
  script(row)
end

function bed.tooltipSource() return GameTooltip._source or "" end
function bed.tooltipText() return table.concat(GameTooltip._lines, "\n") end
function bed.tooltipTextNamed(name) return table.concat(_G[name]._lines, "\n") end
function bed.tooltipShown() return GameTooltip:IsShown() end

function bed.buyRow(index)
  local row = tradeFrame().rows[index]
  row.buy._scripts.OnClick(row.buy)
end

local function scanEntry(itemId)
  local items = WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.items
  return items and items[itemId]
end

function bed.scanned(itemId) return scanEntry(itemId) ~= nil end
function bed.scanMin(itemId)
  local entry = scanEntry(itemId)
  return entry and entry.minPrice
end
function bed.scanAuctions(itemId)
  local entry = scanEntry(itemId)
  return entry and entry.numAuctions
end

function bed.rowName(index) return bed.plain(tradeFrame().rows[index].name._text) end
function bed.cellText(index, slot) return bed.plain(tradeFrame().rows[index].cells[slot]._text) end
function bed.headerText(slot)
  local trade = tradeFrame()
  return bed.plain(slot == 0 and trade.headItem._text or trade.headers[slot]._text)
end

-- ============================== Geometry ==============================

-- The panel has a fixed size and is clamped to the screen; the client's
-- auction frame no longer determines it.
function bed.panelHeight()
  return tradeFrame():GetHeight()
end

-- Smallest gap between the panel's edge and anything anchored to it, per
-- side. The backdrop draws its border inside these same bounds, so this is
-- exactly the room the border art has to occupy without content on top.
function bed.panelClearance(side)
  local panel = tradeFrame()
  local least = nil
  local function keep(value)
    if not least or value < least then least = value end
  end
  for _, frame in ipairs(bed.frames) do
    if frame._parent == panel and frame._points then
      for point, anchor in pairs(frame._points) do
        if anchor.to == panel and point:find(side) then
          if side == "LEFT" then keep(anchor.x)
          elseif side == "RIGHT" then keep(-anchor.x)
          elseif side == "TOP" then keep(-anchor.y)
          else keep(anchor.y) end
        end
      end
    end
  end
  if side == "BOTTOM" then
    local last = panel.rows[#panel.rows]
    keep(bed.panelHeight() + last._points.TOPLEFT.y - last._height)
  end
  return least
end

function bed.backdropInset(side) return tradeFrame()._backdrop.insets[side] end
function bed.visibleRows() return #tradeFrame().rows end

function bed.wrappingCells()
  local panel = tradeFrame()
  local wrapping = 0
  local function check(fontString)
    if fontString._width and fontString._wordWrap ~= false then wrapping = wrapping + 1 end
  end
  for _, label in ipairs(panel.headers) do check(label) end
  for _, row in ipairs(panel.rows) do
    for _, cell in ipairs(row.cells) do check(cell) end
  end
  return wrapping
end

function bed.lastStats() return WowTest.ns.lastScanStats end

-- The options panel builds its checkboxes on first show. Driving the real
-- click handler is the only way to prove a setting takes effect immediately
-- rather than at the next /reload.
function bed.showSettings()
  for _, frame in ipairs(bed.frames) do
    if frame.name == "WoWderhoi AHelper" then
      if frame._scripts.OnShow then frame._scripts.OnShow(frame) end
      return frame
    end
  end
  error("settings panel not built")
end

function bed.clickSetting(key)
  for _, frame in ipairs(bed.frames) do
    if frame.settingKey == key and frame._scripts.OnClick then
      frame._scripts.OnClick(frame)
      return
    end
  end
  error("no settings checkbox for " .. tostring(key))
end

function bed.lastChat() return bed.plain(bed.chat[#bed.chat] or "") end
function bed.anyChat(text)
  for _, line in ipairs(bed.chat) do
    if bed.plain(line):find(text, 1, true) then return true end
  end
  return false
end
