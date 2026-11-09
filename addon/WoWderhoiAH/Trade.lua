-- WAH cockpit: executable-profit radar plus a live price book.
--
-- Every recommendation is produced by Core.lua through WAH.coreInput():
-- the same decision core the desktop terminal runs. The radar shows what
-- can actually be bought and resold under the current phase's gates --
-- buyable quantity, ladder price, suggested sell price, net profit and
-- fill probability -- not a discount against a historical median.
--
-- Buying goes through the modern C_AuctionHouse API: item auctions are
-- bought out by auctionID, commodities are purchased by quantity at the
-- market price (the client's own confirmation dialog shows the real
-- total). A confirmed purchase is written to the journal, so the ledger
-- learns the position and the next evaluation prices it.

local ADDON_NAME, WAH = ...
local L = WAH.L
local coinString = WAH.coinString

local ROWS_VISIBLE = 12 -- replaced in createTradeFrame by what the panel fits
local ROW_HEIGHT = 22
-- The backdrop draws its border art inside the frame's own bounds, so a
-- child anchored at the edge is painted on the bevel. Every child keeps PAD
-- clear of all four sides.
local PAD = 8
local PANEL_WIDTH = 664
local PANEL_HEIGHT = 540

local trade = nil
local results = {} -- search rows
local deals = {} -- radar rows from Core.evaluate
local actionRows = {} -- conditional plans from the same evaluation
local lastEvaluation = nil
local mode = "deals" -- "deals" | "actions" | "results"
local searchState = nil
local searching = nil -- "browse" | "list" | nil
-- The server name-search fallback. One browse may be in flight; a second
-- keystroke replaces `queued`, so an answer is never scored against a query
-- that did not produce it. The response that lands while a newer query is
-- waiting is discarded, not opened.
local browse = nil -- { query = string, queued = string|nil }
local pendingPurchase = nil -- a purchase awaiting AUCTION_HOUSE_PURCHASE_COMPLETED
-- A commodity purchase the request timeout booked before the client stated
-- the fill. The later COMMODITY_PURCHASED is the authority on quantity and
-- cost; it corrects that fact instead of booking a second purchase.
local settledCommodity = nil

local function chatMessage(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WAH|r " .. text)
end

local function currentScan()
  local scan = WAH.currentScan()
  return scan and scan.items
end

local function auctionHouseOpen()
  if WAH.ahOpen then return true end
  local frame = WAH.ahFrame and WAH.ahFrame()
  return frame ~= nil and frame:IsShown()
end

-- ============================ Table model =============================

-- Compact money. GetCoinTextureString always prints all three units with
-- inline coin icons, so no two prices in a column line up. Two units is
-- everything anyone acts on; the third never changes a decision.
local function money(copper)
  local total = math.floor((copper or 0) + 0.5)
  local gold = math.floor(total / 10000)
  local silver = math.floor(total % 10000 / 100)
  if gold > 0 then
    return string.format("|cffffd700%d%s|r |cffc7c7cf%02d%s|r", gold, L.MONEY_G, silver, L.MONEY_S)
  elseif silver > 0 then
    return string.format("|cffc7c7cf%d%s|r |cffeda55f%02d%s|r", silver, L.MONEY_S, total % 100, L.MONEY_C)
  end
  return string.format("|cffeda55f%d%s|r", total % 100, L.MONEY_C)
end

local function moneyCell(value) return money(value) end
local function countCell(value) return tostring(value or 0) end
local function fillCell(value)
  if value == nil then return "|cffaaaaaa—|r" end
  local pct = math.floor(value * 100 + 0.5)
  local color = pct >= 60 and "|cff55ff55" or (pct >= 30 and "|cffffd100" or "|cffaaaaaa")
  return string.format("%s%d%%|r", color, pct)
end

local COL_COUNT = 5
local RADAR_COLUMNS = {
  -- The buyable quantity is the allocated one: all rows share one purse.
  -- Market depth stays in the tooltip.
  { key = "allocQty", label = "COL_QTY", cell = countCell },
  -- The allocated quantity's average price: the whole row describes one
  -- trade, and the deep-ladder average stays in the tooltip via candidateQty.
  { key = "allocUnitPrice", label = "COL_BUY", cell = moneyCell, asc = true },
  { key = "sellP", label = "COL_SELL", cell = moneyCell },
  -- Net of the allocated quantity, so the row's numbers describe the same
  -- trade the quantity column describes.
  { key = "allocNet", label = "COL_NET", cell = moneyCell },
  { key = "fillProb", label = "COL_FILL", cell = fillCell }
}
local ACTION_COLUMNS = {
  { key = "qty", label = "COL_LISTED", cell = countCell },
  { key = "price", label = "COL_UNIT", cell = moneyCell, asc = true },
  { key = "net", label = "COL_NET", cell = moneyCell },
  { key = "fillProb", label = "COL_FILL", cell = fillCell }
}
local RESULT_COLUMNS = {
  { key = "count", label = "COL_LISTED", cell = countCell },
  { key = "unitPrice", label = "COL_UNIT", cell = moneyCell, asc = true },
  { key = "buyout", label = "COL_TOTAL", cell = moneyCell, asc = true }
}

local sortKey = nil
local sortAsc = false

local function columnsForMode()
  if mode == "deals" then return RADAR_COLUMNS end
  if mode == "actions" then return ACTION_COLUMNS end
  return RESULT_COLUMNS
end

local function columnAt(slot)
  local columns = columnsForMode()
  return columns[slot - (COL_COUNT - #columns)]
end

local function visibleRows()
  if mode == "deals" then return deals end
  if mode == "actions" then return actionRows end
  return results
end

-- The radar keeps Core's order: vendor arbitrage first, then the phase's
-- score. A user sort overrides it until the next evaluation.
local function applySort()
  local rows = visibleRows()
  if not sortKey then
    if mode == "results" then
      table.sort(rows, function(left, right) return left.unitPrice < right.unitPrice end)
    end
    return
  end
  -- Plans keep the core's urgency order; a column click must not reorder
  -- "what to do next" into "what looks biggest".
  if mode == "actions" then return end
  table.sort(rows, function(left, right)
    if left[sortKey] == right[sortKey] then return left.name < right.name end
    if sortAsc then return left[sortKey] < right[sortKey] end
    return left[sortKey] > right[sortKey]
  end)
end

local renderRows -- forward declaration; a header click re-renders after sorting

local function sortMark(key)
  if sortKey ~= key then return "" end
  return " " .. (sortAsc and L.SORT_ASC or L.SORT_DESC)
end

local function sortByKey(key, defaultAsc)
  if sortKey == key then
    sortAsc = not sortAsc
  else
    sortKey, sortAsc = key, defaultAsc or false
  end
  applySort()
  FauxScrollFrame_SetOffset(trade.scroll, 0)
  renderRows()
end

-- =============================== Radar ===============================

local function sellerVisibility(scan)
  local visible, total = 0, 0
  for _, entry in pairs(scan or {}) do
    if entry.minPrice and entry.minPrice > 0 then
      total = total + 1
      if not entry.sellersInvisible then visible = visible + 1 end
    end
  end
  return visible, total
end

local function statusLine()
  local scan = currentScan()
  local age = WAH.scanAgeMinutes and WAH.scanAgeMinutes()
  local phase = lastEvaluation and lastEvaluation.phase
    or (WAH.currentPhase and WAH.currentPhase() or "steady")
  local label = (L.PHASE_LABELS and L.PHASE_LABELS[phase]) or phase
  if not scan or age == nil then
    return string.format(L.STATUS_LINE_NO_SCAN, label)
  end
  local count = 0
  for _, entry in pairs(scan) do
    if entry.minPrice and entry.minPrice > 0 then count = count + 1 end
  end
  local visible, total = sellerVisibility(scan)
  local pct = total > 0 and math.floor(visible / total * 100 + 0.5) or 0
  local line = string.format(L.STATUS_LINE, math.floor(age), count, label, pct)
  -- The book the radar priced excludes the player's own listings; say so,
  -- otherwise "why is my item missing" has no answer on the page.
  local selfListings = 0
  for _, entry in pairs(scan) do
    selfListings = selfListings + (entry.selfListings or 0)
  end
  if selfListings > 0 then
    line = line .. string.format(L.STATUS_SELF, selfListings)
  end
  -- Money in the mailbox is earned but not spendable. It is shown so the
  -- purse does not look wrong after a sale, and never budgeted against.
  local pending = WAH.Mail and WAH.Mail.pendingCash and WAH.Mail.pendingCash() or 0
  if pending > 0 then
    line = line .. string.format(L.STATUS_MAIL, coinString(pending))
  end
  return line
end

local function refreshStatus()
  if trade and trade.status then trade.status:SetText(statusLine()) end
end

-- Conditional plans in the shape the table renders. A buy carries the price
-- the allocated quantity pays; a sell carries the listing price the core
-- already netted.
local function rebuildActions()
  wipe(actionRows)
  if not lastEvaluation then return end
  for _, action in ipairs(lastEvaluation.actions) do
    actionRows[#actionRows + 1] = {
      kind = action.kind,
      itemId = action.itemId,
      name = action.name or tostring(action.itemId),
      qty = action.qty or 0,
      price = action.kind == "buy" and (action.unitPrice or action.maxUnitPrice) or action.price,
      net = action.expectedNet or 0,
      perMinute = action.netPerMinute or 0,
      fillProb = action.kind == "buy" and action.fillProb or nil,
      reason = action.reason,
      stop = action.stop
    }
  end
end

local function refreshRadar()
  wipe(deals)
  sortKey = nil
  local scan = currentScan()
  if not scan or not next(scan) then
    chatMessage(L.DEALS_NEED_SCAN)
    refreshStatus()
    return
  end
  lastEvaluation = WAH.Core.evaluate(WAH.coreInput())
  -- The game is the plan authority. Publishing here means the desktop sees
  -- the same steps, resources and identity the player is looking at.
  if lastEvaluation.plan and WAH.publishPlan then
    WAH.publishPlan(lastEvaluation.plan, lastEvaluation.phase)
  end
  local considered = #lastEvaluation.rows
  -- The core already separated the funded layer: the radar promises an
  -- executable trade, so it renders that list rather than re-filtering the
  -- candidate rows with a second copy of `allocQty > 0`.
  for _, row in ipairs(lastEvaluation.opportunities or {}) do
    deals[#deals + 1] = row
  end
  rebuildActions()
  applySort()
  refreshStatus()
  if #deals == 0 then
    local excluded = lastEvaluation.diagnostics and lastEvaluation.diagnostics.excluded or {}
    local sizing = excluded.sizing or 0
    if considered == 0 and sizing == 0 then
      chatMessage(L.RADAR_NONE)
    elseif considered == 0 then
      -- The risk model rejected every gate-passer before it became a row.
      chatMessage(string.format(L.RADAR_SIZING, sizing))
    else
      -- Why the candidates got no copper is the core's answer, not a guess.
      -- Rows the risk model refuses never reach `rows`, so their count is
      -- the excluded.sizing gate rather than an unfunded cause.
      local unfunded = lastEvaluation.diagnostics and lastEvaluation.diagnostics.unfunded or {}
      local message = string.format(L.RADAR_UNFUNDED, considered,
        unfunded.purse or 0, unfunded.exposure or 0, unfunded.depth or 0,
        unfunded.slots or 0)
      -- A risk-model count of zero is not a cause; saying "0 more" reads as
      -- a fourth bucket that happened to be empty.
      if sizing > 0 then
        message = message .. string.format(L.RADAR_UNFUNDED_SIZING, sizing)
      end
      chatMessage(message)
    end
  else
    chatMessage(string.format(L.RADAR_FOUND, #deals,
      (L.PHASE_LABELS and L.PHASE_LABELS[lastEvaluation.phase]) or lastEvaluation.phase))
  end
end

-- The scanner lands a new book while the page may be open. Only a visible
-- page is rebuilt: evaluating the core for a closed panel is wasted work,
-- and the page rebuilds on open anyway.
WAH.refreshRadar = function()
  if not (trade and trade:IsShown()) then return end
  -- A player reading search results keeps that view: a scan landing mid-
  -- search must not re-render the result table or print radar messages. The
  -- radar tabs rebuild on their next click anyway.
  if mode == "results" then return end
  refreshRadar()
  -- The list may have shrunk under the scroll position; keep the view valid
  -- and repaint with the new book.
  local maxOffset = math.max(0, #visibleRows() - ROWS_VISIBLE)
  if FauxScrollFrame_GetOffset(trade.scroll) > maxOffset then
    FauxScrollFrame_SetOffset(trade.scroll, maxOffset)
  end
  renderRows()
end

-- ============================== Buy side ==============================

local function itemKeyFor(itemId)
  return C_AuctionHouse.MakeItemKey(itemId, 0, 0, 0)
end

-- A price book row is either one item auction (auctionID, buyout) or one
-- commodity offer group (quantity at a unit price). Both render through
-- the same columns; only the buy action differs.
local function collectSearchResults()
  if not searchState then return end
  wipe(results)
  if searchState.commodity then
    local itemId = searchState.itemId
    local numResults = C_AuctionHouse.GetNumCommoditySearchResults(itemId)
    for index = 1, numResults do
      local info = C_AuctionHouse.GetCommoditySearchResultInfo(itemId, index)
      if info and info.quantity and info.quantity > 0
        and info.unitPrice and info.unitPrice > 0 then
        results[#results + 1] = {
          auctionID = info.auctionID,
          itemId = itemId,
          name = searchState.name,
          count = info.quantity,
          unitPrice = info.unitPrice,
          buyout = info.unitPrice * info.quantity,
          texture = WAH.itemIcon(itemId),
          commodity = true
        }
      end
    end
    if not C_AuctionHouse.HasFullCommoditySearchResults(itemId) then
      C_AuctionHouse.RequestMoreCommoditySearchResults(itemId)
    end
  else
    local itemKey = searchState.itemKey
    local numResults = C_AuctionHouse.GetNumItemSearchResults(itemKey)
    for index = 1, numResults do
      local info = C_AuctionHouse.GetItemSearchResultInfo(itemKey, index)
      -- Bid-only auctions have no buyout and are not an actionable purchase
      -- for a price book that promises "buy this now".
      local price = info and info.buyoutAmount
      if info and info.auctionID and info.quantity and info.quantity > 0
        and price and price > 0 then
        results[#results + 1] = {
          auctionID = info.auctionID,
          itemId = searchState.itemId,
          name = searchState.name,
          count = info.quantity,
          buyout = price,
          unitPrice = price / info.quantity,
          texture = WAH.itemIcon(searchState.itemId),
          itemLink = info.itemLink,
          commodity = false
        }
      end
    end
    if not C_AuctionHouse.HasFullItemSearchResults(itemKey) then
      C_AuctionHouse.RequestMoreItemSearchResults(itemKey)
    end
  end
  sortKey = nil
  applySort()
  -- The market price a commodity purchase will actually pay is the cheapest
  -- visible unit price, regardless of which offer row the player clicked.
  if searchState.commodity and results[1] then
    searchState.marketUnitPrice = results[1].unitPrice
  end
end

-- A commodity purchase walks the offer ladder from the cheapest unit up, so
-- the cost of buying N units is not N times any single row's price. The
-- ladder is snapshotted at click time: the completion event reports how
-- many units actually filled, and pricing that quantity needs the book the
-- player confirmed against, not the search results the purchase just ate.
local function offerTiers(itemId)
  local byPrice = {}
  for _, row in ipairs(results) do
    if row.itemId == itemId and row.count and row.count > 0 then
      byPrice[row.unitPrice] = (byPrice[row.unitPrice] or 0) + row.count
    end
  end
  local tiers = {}
  for price, count in pairs(byPrice) do tiers[#tiers + 1] = { p = price, q = count } end
  table.sort(tiers, function(left, right) return left.p < right.p end)
  return tiers
end

-- Costs the requested quantity against the same ladder the decision core
-- prices. Returns nil when the visible book cannot fill the quantity.
local function commodityCost(tiers, quantity)
  return WAH.Core.ladderCost(tiers, quantity)
end

local runSearch -- forward declaration

-- The radar reads the session scan as its record of what is listed right
-- now, and only a full rescan rewrites it — so buying the cheapest listing
-- left the scan advertising a price nobody can pay. The live result rows are
-- the one fresh evidence a session has; rebuild the ladder from them.
--
-- Ceiling: those rows are one search's results, never the whole book, so
-- the rebuilt ladder is never deeper than the truth. It can hide a real
-- deal until the next scan; it can never invent one.
local function repriceAfterPurchase(bought)
  local scan = currentScan()
  local scanned = scan and scan[bought.itemId]
  if not scanned then return end
  -- A commodity purchase walks the cheapest offers first, regardless of
  -- which row the player clicked, so decrement in that order.
  if bought.via == "commodity" then
    local offers = {}
    for _, row in ipairs(results) do
      if row.itemId == bought.itemId then offers[#offers + 1] = row end
    end
    table.sort(offers, function(left, right) return left.unitPrice < right.unitPrice end)
    local remaining = bought.qty or 0
    for _, offer in ipairs(offers) do
      if remaining <= 0 then break end
      local take = math.min(remaining, offer.count)
      offer.count = offer.count - take
      remaining = remaining - take
    end
  end
  local tiersByPrice = {}
  local cheapest, quantity, listings = nil, 0, 0
  for _, row in ipairs(results) do
    if row.itemId == bought.itemId and row.count and row.count > 0
      and (bought.via == "commodity" or row.auctionID ~= bought.auctionID) then
      tiersByPrice[row.unitPrice] = (tiersByPrice[row.unitPrice] or 0) + row.count
      quantity = quantity + row.count
      listings = listings + 1
      if not cheapest or row.unitPrice < cheapest then cheapest = row.unitPrice end
    end
  end
  if not cheapest then
    scan[bought.itemId] = nil
    return
  end
  local tiers = {}
  for price, count in pairs(tiersByPrice) do tiers[#tiers + 1] = { p = price, q = count } end
  table.sort(tiers, function(left, right) return left.p < right.p end)
  -- Rebuild the front with the same rule the scanner used: item auctions
  -- measure depth in listings, commodities in units, and ignition asks for
  -- a shallower front. The market type is the one the scan recorded; deriving
  -- it again from the surviving rows would flip a stack-bearing item auction
  -- to commodity as the book shrinks.
  local marketType = scanned.marketType or WAH.Core.marketTypeFor({
    itemClass = scanned.itemClass,
    quantity = scanned.quantity,
    numAuctions = scanned.numAuctions
  })
  local phase = WAH.currentPhase and WAH.currentPhase() or "steady"
  scanned.minPrice = cheapest
  scanned.tiers = tiers
  scanned.quantity = quantity
  scanned.numAuctions = listings
  scanned.sellP = WAH.Core.sellFront(tiers, {
    rules = WAH.RULES.sellFront,
    byCount = marketType == "item",
    early = phase == "ignition"
  }) or cheapest
end

-- A purchase awaiting the client's confirmation. `confirmed` marks that a
-- completion signal arrived; the three-second timeout must not warn about a
-- purchase that is merely still being settled.
local function awaitPurchase(purchase)
  pendingPurchase = purchase
  C_Timer.After(3, function()
    if pendingPurchase ~= purchase or purchase.confirmed then return end
    pendingPurchase = nil
    chatMessage(L.PURCHASE_UNCONFIRMED)
  end)
end

-- The event payload never carries the fill details (AUCTION_HOUSE_PURCHASE_
-- COMPLETED is just an auctionID), so the booked quantity is the one the
-- purchase recorded — the request for item auctions, and the client-reported
-- fill for commodities.
local function recordPurchase(purchase, quiet)
  if WAH.Actions then
    if purchase.via == "commodity" then
      WAH.Actions.commodityPurchase(purchase.itemId, purchase.qty, purchase)
    else
      WAH.Actions.purchase(purchase.auctionID, purchase)
    end
  else
    WAH.recordEvent({
      k = "buy",
      itemId = purchase.itemId,
      qty = purchase.qty,
      cost = purchase.cost
    })
  end
  -- The action may already have been booked by the event frame; the chat
  -- line still belongs to this purchase. A correction re-states a purchase
  -- the player was already told about.
  if not quiet then
    chatMessage(string.format(L.BOUGHT, purchase.name, purchase.qty, coinString(purchase.cost)))
  end
end

-- Settle a confirmed purchase: reprice the book the player is looking at and
-- re-run the search so the bought units drop off. `correction` restates a
-- purchase the request timeout already settled; the book was repriced from
-- the requested quantity, so only the booked fact may change.
local function completePurchase(purchase, filled, correction)
  if filled and filled > 0 then
    purchase.qty = filled
    local cost = purchase.tiers and WAH.Core.ladderCost(purchase.tiers, filled)
    if cost then purchase.cost = cost end
  end
  recordPurchase(purchase, correction)
  if correction then return end
  repriceAfterPurchase(purchase.row)
  C_Timer.After(0.6, function()
    if trade and trade:IsShown() and mode == "results" then runSearch() end
  end)
end

-- The plan's price ceiling is a condition, not a caption. Checking it here
-- is what makes `stop.ifPriceAbove` executable: a book that moved above the
-- cap after the radar ran must not be bought at the new price.
local function rejectAboveCap(unitPrice)
  local cap = searchState and searchState.maxUnitPrice
  if not cap or not unitPrice or unitPrice <= cap then return false end
  chatMessage(string.format("|cffff5555" .. L.BUY_CAP .. "|r",
    coinString(math.floor(unitPrice + 0.5)), coinString(math.floor(cap + 0.5))))
  return true
end

local function verifyAndBuy(row)
  if row.commodity then
    -- Commodities cannot be targeted by auctionID: the purchase always takes
    -- the cheapest units currently listed. Re-check the market price, then
    -- hand the total to the client's own confirmation dialog.
    local info = C_AuctionHouse.GetCommoditySearchResultInfo(row.itemId, 1)
    if not info or not info.unitPrice
      or (searchState and info.unitPrice ~= searchState.marketUnitPrice) then
      chatMessage("|cffff5555" .. L.LISTING_CHANGED .. "|r")
      return
    end
    local tiers = offerTiers(row.itemId)
    local estimate = commodityCost(tiers, row.count)
    if not estimate then
      chatMessage(L.COMMODITY_NO_DEPTH)
      return
    end
    -- A commodity purchase walks the ladder, so the price that matters is
    -- the average the requested quantity actually pays.
    if rejectAboveCap(estimate / row.count) then return end
    awaitPurchase({ itemId = row.itemId, name = row.name, qty = row.count,
      cost = estimate, tiers = tiers, via = "commodity", row = row })
    C_AuctionHouse.StartCommoditiesPurchase(row.itemId, row.count)
    chatMessage(string.format(L.COMMODITY_STARTED, row.name, row.count,
      coinString(estimate)))
    return
  end
  local info = C_AuctionHouse.GetAuctionInfoByID(row.auctionID)
  if not info or not info.buyoutAmount or info.buyoutAmount ~= row.buyout then
    chatMessage("|cffff5555" .. L.LISTING_CHANGED .. "|r")
    return
  end
  if rejectAboveCap(info.buyoutAmount / (info.quantity or row.count)) then return end
  C_AuctionHouse.PlaceBid(row.auctionID, row.buyout)
  awaitPurchase({ itemId = row.itemId, name = row.name, qty = row.count,
    cost = row.buyout, via = "item", auctionID = row.auctionID, row = row })
end

renderRows = function()
  if not trade then return end
  local rows = visibleRows()
  trade.headItem:SetText((mode == "actions" and L.COL_ACTION or L.COL_ITEM) .. sortMark("name"))
  for slot = 1, COL_COUNT do
    local column = columnAt(slot)
    trade.headers[slot]:SetText(column and (L[column.label] .. sortMark(column.key)) or "")
  end
  local offset = FauxScrollFrame_GetOffset(trade.scroll)
  FauxScrollFrame_Update(trade.scroll, #rows, ROWS_VISIBLE, ROW_HEIGHT)
  for rowIndex = 1, ROWS_VISIBLE do
    local rowFrame = trade.rows[rowIndex]
    local row = rows[rowIndex + offset]
    if row then
      for slot = 1, COL_COUNT do
        local column = columnAt(slot)
        rowFrame.cells[slot]:SetText(column and column.cell(row[column.key]) or "")
      end
      if mode == "deals" then
        rowFrame.icon:SetTexture(WAH.itemIcon(row.itemId))
        rowFrame.showTooltip = function()
          GameTooltip:SetHyperlink("item:" .. row.itemId)
          if row.reason then GameTooltip:AddLine(row.reason, 1, 0.82, 0) end
          if not row.vendor then
            GameTooltip:AddLine(string.format(L.RADAR_ALLOC, row.candidateQty or 0, row.allocQty or 0), 1, 1, 1)
          end
        end
        rowFrame.name:SetText(row.vendor
          and string.format("%s |cffffd100[%s]|r", row.name, L.VENDOR_TAG)
          or row.name)
        rowFrame.buy:SetText(L.FIND)
        rowFrame.buy:SetScript("OnClick", function()
          trade.searchBox:SetText(row.name)
          searchState = nil
          searching = nil
          WAH.searchItem(row.itemId, row.name)
        end)
      elseif mode == "actions" then
        rowFrame.icon:SetTexture(WAH.itemIcon(row.itemId))
        rowFrame.showTooltip = function()
          GameTooltip:SetHyperlink("item:" .. row.itemId)
          if row.perMinute and row.perMinute > 0 then
            GameTooltip:AddLine(string.format(L.ACTION_PER_MINUTE, coinString(row.perMinute)), 1, 1, 1)
          end
          if row.reason then GameTooltip:AddLine(row.reason, 1, 0.82, 0) end
          if row.stop and row.stop.ifPriceAbove then
            GameTooltip:AddLine(string.format(L.ACTION_ABORT, coinString(row.stop.ifPriceAbove)), 1, 1, 1)
          end
        end
        local tag = row.kind == "sell" and L.ACTION_SELL or L.ACTION_BUY
        local color = row.kind == "sell" and "|cff66ccff" or "|cff55ff55"
        rowFrame.name:SetText(string.format("%s%s|r %s", color, tag, row.name))
        rowFrame.buy:SetText(row.kind == "sell" and L.SELL_PAGE or L.FIND)
        rowFrame.buy:SetScript("OnClick", function()
          if row.kind == "sell" then
            if WAH.openSell then WAH.openSell() end
            -- Preselect the item whose plan the player clicked; the sell
            -- page recomputes the plan against the live bag.
            if WAH.Sell and WAH.Sell.select then WAH.Sell.select(row.itemId) end
          else
            trade.searchBox:SetText(row.name)
            searchState = nil
            searching = nil
            -- Carry the plan's cap into the search: the results table and
            -- the buy click both enforce it.
            WAH.searchItem(row.itemId, row.name, row)
          end
        end)
      else
        rowFrame.icon:SetTexture(row.texture or WAH.itemIcon(row.itemId))
        -- A result row above the searched plan's cap is marked where the
        -- player reads the price, not only in the chat line at click time.
        local cap = searchState and searchState.maxUnitPrice
        local overCap = cap ~= nil and row.unitPrice and row.unitPrice > cap
        rowFrame.showTooltip = function()
          GameTooltip:SetHyperlink(row.itemLink or ("item:" .. row.itemId))
          if overCap then
            GameTooltip:AddLine(string.format(L.ACTION_ABORT, coinString(math.floor(cap + 0.5))), 1, 0.3, 0.3)
          end
        end
        rowFrame.name:SetText(row.name)
        rowFrame.buy:SetText(row.commodity and L.BUY_MARKET or L.BUY)
        rowFrame.buy:SetScript("OnClick", function() verifyAndBuy(row) end)
        for slot = 1, COL_COUNT do
          local column = columnAt(slot)
          if column and column.key == "unitPrice" then
            if overCap then
              rowFrame.cells[slot]:SetTextColor(1, 0.3, 0.3)
            else
              rowFrame.cells[slot]:SetTextColor(1, 1, 1)
            end
          end
        end
      end
      rowFrame:Show()
    else
      rowFrame:Hide()
    end
  end
end

-- ============================== Search flow ===========================

local function sameItemKey(left, right)
  return left and right and left.itemID == right.itemID
end

function WAH.searchItem(itemId, name, plan)
  if not auctionHouseOpen() then
    chatMessage(L.SEARCH_NEED_AH)
    searching = nil
    return
  end
  local itemKey = itemKeyFor(itemId)
  local info = C_AuctionHouse.GetItemKeyInfo(itemKey)
  if not info then
    chatMessage(string.format(L.SEARCH_NOT_FOUND, name or tostring(itemId)))
    searching = nil
    return
  end
  searchState = {
    itemKey = itemKey,
    itemId = itemId,
    name = info.itemName or name or tostring(itemId),
    commodity = info.isCommodity,
    -- The buy plan's own ceiling. A plain search has no plan and therefore
    -- no cap; the rows are then informational until the player decides.
    maxUnitPrice = plan and (plan.stop and plan.stop.ifPriceAbove or plan.maxUnitPrice) or nil
  }
  -- Opening an item resolves the name search: the browse that produced it
  -- has no answer left to deliver.
  browse = nil
  searching = "list"
  mode = "results"
  -- Drop the previous item's rows before the new response arrives: a stale
  -- book under a new search box is the one display that can be mistaken for
  -- the item the player just asked for.
  wipe(results)
  sortKey = nil
  if trade then
    FauxScrollFrame_SetOffset(trade.scroll, 0)
    renderRows()
  end
  C_AuctionHouse.SendSearchQuery(itemKey,
    { { sortOrder = Enum.AuctionHouseSortOrder.Price, reverseSort = false } }, false)
end

-- Typed names are resolved against the session scan first: it holds the
-- realm's own names, including localized ones the client's search may not
-- match, and it avoids spending a browse query on every keystroke. The
-- ranking itself lives in Core, so the terminal's table and this box agree
-- on what "the closest name" means.
local function resolveFromScan(query)
  local scan = currentScan()
  if not scan then return nil end
  local candidates = {}
  for itemId, entry in pairs(scan) do
    candidates[#candidates + 1] = {
      itemId = tonumber(itemId),
      name = entry.name,
      -- A book the player can buy from outranks a bid-only observation at
      -- the same name score; a bid-only item opens a search with no rows.
      booked = entry.minPrice and entry.minPrice > 0 or false,
      quantity = entry.quantity or 0
    }
  end
  local best = WAH.Core.rankSearch(candidates, query)[1]
  return best and { itemId = best.itemId, name = best.name } or nil
end

-- Start one browse and remember the query it was sent for. Any answer that
-- arrives is ranked against this query, never against a newer text box.
local function sendBrowseQuery(query)
  browse = { query = query, queued = nil }
  searching = "browse"
  searchState = nil
  mode = "results"
  C_AuctionHouse.SendBrowseQuery({
    searchString = query,
    sorts = { { sortOrder = Enum.AuctionHouseSortOrder.Price, reverseSort = false } }
  })
end

runSearch = function()
  if not trade then return end
  if WAH.scanRunning then
    chatMessage(L.SCAN_WAIT)
    return
  end
  -- The shared parser owns what counts as an empty query and which
  -- characters separate name tokens. A `%s` trim here left a full-width
  -- space looking non-empty and still sent the raw string to the server.
  local parsed = WAH.Core.parseSearchQuery(trade.searchBox:GetText())
  if not parsed then return end
  local query = parsed.text
  if not auctionHouseOpen() then
    chatMessage(L.SEARCH_NEED_AH)
    return
  end
  local hit = resolveFromScan(query)
  if hit then
    WAH.searchItem(hit.itemId, hit.name)
    return
  end
  -- Nothing in the scan matches: fall back to the server's own name search,
  -- then open the result whose name is the closest match. Only one browse
  -- may be in flight; a newer query waits for the answer to be discarded.
  if browse then
    browse.queued = query
    return
  end
  sendBrowseQuery(query)
end

-- ============================== Frame =================================

local function createTradeFrame()
  trade = CreateFrame("Frame", "WoWderhoiAHTrade", UIParent, "BackdropTemplate")
  trade:SetSize(PANEL_WIDTH, PANEL_HEIGHT)
  trade:SetClampedToScreen(true)
  trade:SetMovable(true)
  local auctionHouse = WAH.ahFrame()
  if auctionHouse then
    trade:SetPoint("TOPLEFT", auctionHouse, "TOPRIGHT", 4, 0)
    trade:SetHeight(math.min(auctionHouse:GetHeight() or PANEL_HEIGHT, PANEL_HEIGHT))
  else
    trade:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
  end
  trade:SetBackdrop({
    bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
    edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile = true, tileSize = 32, edgeSize = 20,
    insets = { left = 5, right = 5, top = 5, bottom = 5 }
  })

  trade.title = trade:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  trade.title:SetPoint("TOPLEFT", PAD, -PAD)
  trade.title:SetText(L.TRADE_TITLE)

  local close = CreateFrame("Button", nil, trade, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -PAD, -PAD)
  close:SetScript("OnClick", function() trade:Hide() end)

  -- A dedicated drag strip: making the whole frame draggable would swallow
  -- clicks meant for the table underneath.
  local drag = CreateFrame("Button", nil, trade)
  drag:SetPoint("TOPLEFT", PAD, -PAD)
  drag:SetPoint("TOPRIGHT", -PAD - 44, -PAD)
  drag:SetHeight(20)
  drag:RegisterForDrag("LeftButton")
  drag:SetScript("OnDragStart", function() trade:StartMoving() end)
  drag:SetScript("OnDragStop", function() trade:StopMovingOrSizing() end)

  -- The status line is where every "why is this empty / stale / hidden"
  -- answer belongs; chat is only for events worth reading after leaving.
  trade.status = trade:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  trade.status:SetPoint("TOPLEFT", PAD, -26)
  trade.status:SetPoint("TOPRIGHT", -PAD - 44, -26)
  trade.status:SetJustifyH("LEFT")
  trade.status:SetText(statusLine())

  trade.searchBox = CreateFrame("EditBox", "WoWderhoiAHTradeSearch", trade, "SearchBoxTemplate")
  trade.searchBox:SetSize(170, 20)
  trade.searchBox:SetPoint("TOPLEFT", PAD, -42)
  trade.searchBox:SetAutoFocus(false)
  trade.searchBox:SetScript("OnEnterPressed", runSearch)

  local function headerButton(label, anchor, width, onClick)
    local button = CreateFrame("Button", nil, trade, "UIPanelButtonTemplate")
    button:SetSize(width, 20)
    button:SetPoint("LEFT", anchor, "RIGHT", 6, 0)
    button:SetText(label)
    button:SetScript("OnClick", onClick)
    return button
  end

  local searchButton = headerButton(L.SEARCH, trade.searchBox, 58, runSearch)
  local dealsButton = headerButton(L.FIND_DEALS, searchButton, 78, function()
    mode = "deals"
    refreshRadar()
    FauxScrollFrame_SetOffset(trade.scroll, 0)
    renderRows()
  end)
  local actionsButton = headerButton(L.NEXT_STEPS, dealsButton, 58, function()
    -- Evaluate first: the plan must describe the scan on screen, not the
    -- one the radar happened to render last.
    if not currentScan() then
      chatMessage(L.DEALS_NEED_SCAN)
      return
    end
    mode = "deals"
    refreshRadar()
    rebuildActions()
    mode = "actions"
    sortKey = nil
    FauxScrollFrame_SetOffset(trade.scroll, 0)
    renderRows()
    if #actionRows > 0 then
      chatMessage(string.format(L.ACTIONS_FOUND, #actionRows))
      chatMessage(L.ACTIONS_ADOPT_HINT)
    else
      chatMessage(L.ACTIONS_EMPTY)
    end
  end)
  local scanButton = headerButton(L.FULL_SCAN, actionsButton, 78, function()
    if WAH.startScan then WAH.startScan() end
  end)
  local optionsButton = headerButton(L.OPTIONS, scanButton, 56, function() WAH.openSettings() end)
  headerButton(L.SELL_PAGE, optionsButton, 50, function() if WAH.openSell then WAH.openSell() end end)

  -- Table header row: fixed columns, right-aligned numbers.
  local HEADER_Y = -70
  local COL_BUY_W, COL_W, COL_GAP = 58, 70, 6
  local SCROLL_W = 24
  local ICON_X, ICON_W, NAME_GAP = 4, 18, 6
  local function makeSortable(label, onClick)
    local hit = CreateFrame("Button", nil, trade)
    hit:SetAllPoints(label)
    hit:SetScript("OnClick", onClick)
    hit:SetScript("OnEnter", function() label:SetTextColor(1, 1, 1) end)
    hit:SetScript("OnLeave", function() label:SetTextColor(1, 0.82, 0) end)
  end

  trade.headItem = trade:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  trade.headItem:SetPoint("TOPLEFT", PAD + ICON_X + ICON_W + NAME_GAP, HEADER_Y)
  trade.headItem:SetText(L.COL_ITEM)
  makeSortable(trade.headItem, function() sortByKey("name", true) end)

  trade.headers = {}
  for slot = 1, COL_COUNT do
    local label = trade:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    label:SetPoint("TOPRIGHT", trade, "TOPRIGHT",
      -(SCROLL_W + COL_BUY_W + COL_GAP + (COL_COUNT - slot) * (COL_W + COL_GAP)), HEADER_Y)
    label:SetWidth(COL_W)
    label:SetJustifyH("RIGHT")
    label:SetWordWrap(false)
    makeSortable(label, function()
      local column = columnAt(slot)
      if column then sortByKey(column.key, column.asc) end
    end)
    trade.headers[slot] = label
  end
  local headerLine = trade:CreateTexture(nil, "ARTWORK")
  headerLine:SetColorTexture(0.6, 0.5, 0.3, 0.6)
  headerLine:SetPoint("TOPLEFT", PAD, HEADER_Y - 14)
  headerLine:SetPoint("TOPRIGHT", -SCROLL_W, HEADER_Y - 14)
  headerLine:SetHeight(1)

  local ROWS_TOP = -88
  local TOP_INSET, BOTTOM_INSET = 86, 38
  local rowSpace = trade:GetHeight() - TOP_INSET - BOTTOM_INSET + ROWS_TOP - PAD
  ROWS_VISIBLE = math.max(math.floor(rowSpace / ROW_HEIGHT), 1)

  trade.scroll = CreateFrame("ScrollFrame", "WoWderhoiAHTradeScroll", trade, "FauxScrollFrameTemplate")
  trade.scroll:SetPoint("TOPLEFT", PAD, ROWS_TOP)
  trade.scroll:SetPoint("BOTTOMRIGHT", -SCROLL_W, PAD)
  trade.scroll:SetScript("OnVerticalScroll", function(self, delta)
    FauxScrollFrame_OnVerticalScroll(self, delta, ROW_HEIGHT, renderRows)
  end)

  trade.rows = {}
  for rowIndex = 1, ROWS_VISIBLE do
    local rowFrame = CreateFrame("Frame", nil, trade)
    rowFrame:SetHeight(ROW_HEIGHT)
    rowFrame:SetPoint("TOPLEFT", PAD, ROWS_TOP - (rowIndex - 1) * ROW_HEIGHT)
    rowFrame:SetPoint("TOPRIGHT", trade, "TOPRIGHT", -SCROLL_W, ROWS_TOP - (rowIndex - 1) * ROW_HEIGHT)
    if rowIndex % 2 == 0 then
      local shade = rowFrame:CreateTexture(nil, "BACKGROUND")
      shade:SetAllPoints()
      shade:SetColorTexture(1, 1, 1, 0.04)
    end
    local separator = rowFrame:CreateTexture(nil, "BORDER")
    separator:SetColorTexture(0, 0, 0, 0.35)
    separator:SetPoint("BOTTOMLEFT", 0, 0)
    separator:SetPoint("BOTTOMRIGHT", 0, 0)
    separator:SetHeight(1)
    rowFrame.icon = rowFrame:CreateTexture(nil, "ARTWORK")
    rowFrame.icon:SetSize(ICON_W, ICON_W)
    rowFrame.icon:SetPoint("LEFT", ICON_X, 0)
    rowFrame.buy = CreateFrame("Button", nil, rowFrame, "UIPanelButtonTemplate")
    rowFrame.buy:SetSize(COL_BUY_W, 18)
    rowFrame.buy:SetPoint("RIGHT", 0, 0)
    rowFrame.cells = {}
    local anchor = rowFrame.buy
    for slot = COL_COUNT, 1, -1 do
      local cell = rowFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
      cell:SetPoint("RIGHT", anchor, "LEFT", -COL_GAP, 0)
      cell:SetWidth(COL_W)
      cell:SetJustifyH("RIGHT")
      cell:SetWordWrap(false)
      rowFrame.cells[slot] = cell
      anchor = cell
    end
    rowFrame.name = rowFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    rowFrame.name:SetPoint("LEFT", rowFrame.icon, "RIGHT", NAME_GAP, 0)
    rowFrame.name:SetPoint("RIGHT", rowFrame.cells[1], "LEFT", -COL_GAP, 0)
    rowFrame.name:SetJustifyH("LEFT")
    rowFrame.name:SetWordWrap(false)
    rowFrame:EnableMouse(true)
    rowFrame:SetScript("OnEnter", function(self)
      if not self.showTooltip then return end
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
      self.showTooltip()
    end)
    rowFrame:SetScript("OnLeave", function() GameTooltip:Hide() end)
    rowFrame:Hide()
    trade.rows[rowIndex] = rowFrame
  end
  trade:Hide()
  -- The page is a chart host from the moment it exists. Registering here,
  -- rather than when the chart next looks for an anchor, is what makes a
  -- page created inside AUCTION_HOUSE_SHOW take the chart immediately.
  WAH.registerChartHost(trade, 10)
end

local function ensureTradeFrame()
  if not trade then createTradeFrame() end
  return trade
end

function WAH.tradeFrame()
  return trade
end

function WAH.openTrade()
  ensureTradeFrame()
  trade:Show()
  mode = "deals"
  refreshRadar()
  FauxScrollFrame_SetOffset(trade.scroll, 0)
  renderRows()
end

function WAH.toggleTrade()
  ensureTradeFrame()
  if trade:IsShown() then
    trade:Hide()
  else
    WAH.openTrade()
  end
end

-- The 1.60 client shows an addon compartment button when a TOC declares
-- AddonCompartmentFunc. It is the discoverable entry point; /wahtrade is the
-- keyboard one.
function WoWderhoiAH_OnAddonCompartmentClick()
  if WAH.toggleTrade then WAH.toggleTrade() end
end

SLASH_WOWDERHOIAHTRADE1 = "/wahtrade"
SlashCmdList["WOWDERHOIAHTRADE"] = function() WAH.toggleTrade() end

local tradeEvents = CreateFrame("Frame")
tradeEvents:RegisterEvent("AUCTION_HOUSE_SHOW")
tradeEvents:RegisterEvent("AUCTION_HOUSE_CLOSED")
tradeEvents:RegisterEvent("AUCTION_HOUSE_NEW_RESULTS_RECEIVED")
tradeEvents:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")
tradeEvents:RegisterEvent("AUCTION_HOUSE_BROWSE_RESULTS_ADDED")
tradeEvents:RegisterEvent("AUCTION_HOUSE_BROWSE_FAILURE")
tradeEvents:RegisterEvent("AUCTION_HOUSE_PURCHASE_COMPLETED")
-- Commodity fills report their own quantity; the auction completion event
-- only names an auctionID.
tradeEvents:RegisterEvent("COMMODITY_PURCHASED")

tradeEvents:SetScript("OnEvent", function(_, event, payload, extra)
  if event == "AUCTION_HOUSE_SHOW" then
    ensureTradeFrame()
    if not (WAH.settings and WAH.settings.tradeOnOpen) then return end
    WAH.openTrade()
    return
  end
  if event == "AUCTION_HOUSE_CLOSED" then
    if trade then trade:Hide() end
    searching = nil
    searchState = nil
    browse = nil
    pendingPurchase = nil
    settledCommodity = nil
    return
  end
  if event == "AUCTION_HOUSE_BROWSE_FAILURE" then
    if searching then
      searching = nil
      browse = nil
      chatMessage(L.SEARCH_FAILED)
    end
    return
  end
  if event == "COMMODITY_PURCHASED" then
    -- The authoritative fill: itemID plus the quantity the client actually
    -- bought. A request of 20 units can settle as 7 on a thinning book, and
    -- only this event states how many units reached the bag.
    local purchase = pendingPurchase
    if purchase and purchase.via == "commodity" and (payload == nil or payload == purchase.itemId) then
      pendingPurchase = nil
      completePurchase(purchase, extra)
    elseif settledCommodity and (payload == nil or payload == settledCommodity.itemId) then
      -- The timeout already booked this purchase from the request. The
      -- client's fill is the authority, so restate that same fact rather
      -- than appending a second buy.
      local settled = settledCommodity
      settledCommodity = nil
      if extra ~= nil then completePurchase(settled, extra, true) end
    elseif payload ~= nil and extra ~= nil then
      -- A purchase made through the Blizzard UI has no local pending record.
      -- The event still names the item and the fill; book it with an
      -- estimated cost rather than losing the action.
      if WAH.Actions then WAH.Actions.commodityPurchase(payload, extra) end
    end
    return
  end
  if event == "AUCTION_HOUSE_PURCHASE_COMPLETED" then
    local purchase = pendingPurchase
    if purchase then
      purchase.confirmed = true
      if purchase.via == "commodity" then
        -- Give COMMODITY_PURCHASED a moment to report the true fill before
        -- booking the requested quantity. Keep the settled record so a fill
        -- that arrives after this window corrects the fact it booked.
        C_Timer.After(0.5, function()
          if pendingPurchase ~= purchase then return end
          pendingPurchase = nil
          settledCommodity = purchase
          completePurchase(purchase)
          C_Timer.After(10, function()
            if settledCommodity == purchase then settledCommodity = nil end
          end)
        end)
      else
        pendingPurchase = nil
        completePurchase(purchase)
      end
    elseif WAH.Actions then
      -- Native item-auction purchase: the completion event names the
      -- auctionID, and GetAuctionInfoByID still resolves the item.
      WAH.Actions.purchase(payload)
    end
    return
  end
  -- Browse resolution: the server answered a typed name search with a list
  -- of item keys. A server page can hold several similar names; the shared
  -- ranking opens the one the player meant, and a page where nothing
  -- matches is a failure rather than an arbitrary first row.
  if searching == "browse" and not searchState then
    -- This answer belongs to an older query: drop it and send the text the
    -- player has typed since. Scoring it against the new query is the race
    -- that opened the wrong item.
    if browse and browse.queued then
      local nextQuery = browse.queued
      sendBrowseQuery(nextQuery)
      return
    end
    local currentQuery = browse and browse.query
    local candidates = {}
    for _, result in pairs(C_AuctionHouse.GetBrowseResults() or {}) do
      local itemKey = result.itemKey
      if itemKey then
        local info = C_AuctionHouse.GetItemKeyInfo(itemKey)
        local candidate = {
          itemKey = itemKey,
          itemId = itemKey.itemID,
          name = info and info.itemName,
          booked = (result.minPrice or 0) > 0,
          quantity = result.totalQuantity or 0
        }
        candidates[#candidates + 1] = candidate
      end
    end
    local best = WAH.Core.rankSearch(candidates, currentQuery)[1]
    browse = nil
    if not best then
      searching = nil
      chatMessage(L.SEARCH_FAILED)
      return
    end
    searching = nil
    WAH.searchItem(best.itemKey.itemID)
    return
  end
  -- Item search: results arrive in pages, and every page re-reads the full
  -- set, so a later page replaces rather than appends. A browse signal with
  -- no payload can also arrive while our search state is live; the result
  -- count is what proves the signal belongs to our item.
  if searchState and mode == "results" then
    local itemKey = payload
    if itemKey ~= nil and not sameItemKey(itemKey, searchState.itemKey) then return end
    local available
    if searchState.commodity then
      available = C_AuctionHouse.GetNumCommoditySearchResults(searchState.itemId)
    else
      available = C_AuctionHouse.GetNumItemSearchResults(searchState.itemKey)
    end
    if available == 0 then
      if searching == "list" and event == "AUCTION_HOUSE_NEW_RESULTS_RECEIVED" then
        searching = nil
        chatMessage(string.format(L.SEARCH_NOT_FOUND, searchState.name))
      end
      return
    end
    collectSearchResults()
    local firstBatch = searching == "list"
    searching = nil
    FauxScrollFrame_SetOffset(trade.scroll, 0)
    renderRows()
    if firstBatch then
      chatMessage(string.format(L.N_LISTINGS, #results))
    end
  end
end)
