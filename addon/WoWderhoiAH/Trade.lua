-- WAH page: deal radar plus a live price book for WoW Forever.
--
-- The radar crosses this session's replicate scan against the in-game 7d P10
-- median to surface listings 15%+ below their usual price. Buying goes
-- through the modern C_AuctionHouse API: item auctions are bought out by
-- auctionID, commodities are purchased by quantity at the market price (the
-- client's own confirmation dialog shows the real total).
--
-- The page is a standalone panel, not an injected auction-house tab. The
-- 1.60 client's auction frame is built from Blizzard's modern UI package and
-- its tab internals are not part of the addon API; anchoring our own panel
-- beside it keeps the page independent of that package and of other addons.

local ADDON_NAME, WAH = ...
local L = WAH.L
local coinString = WAH.coinString

local ROWS_VISIBLE = 12 -- replaced in createTradeFrame by what the panel fits
local ROW_HEIGHT = 22
-- The backdrop draws its border art inside the frame's own bounds, so a
-- child anchored at the edge is painted on the bevel. Every child keeps PAD
-- clear of all four sides.
local PAD = 8
local PANEL_WIDTH = 560
local PANEL_HEIGHT = 520

local trade = nil
local results = {} -- search rows: { auctionID, itemId, name, count, buyout, unitPrice, texture, itemLink, commodity }
local deals = {} -- radar rows: { itemId, name, minPrice, med7, discountPercent }
local mode = "deals" -- which list the scroll frame renders
local searchState = nil -- { itemKey, itemId, name, commodity }
local searching = nil -- "browse" | "list" | nil
local pendingCommodity = nil -- row whose purchase dialog is open

local function chatMessage(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WAH|r " .. text)
end

local function currentScan()
  local scan = WoWderhoiAH_ScanData
  if not scan or scan.dataVersion ~= WAH.PIPELINE_VERSION then return nil end
  return scan.items
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
-- Deliberately keeps the silver that formatWowMoney's compact mode drops
-- past 100g: 199g99s is a bait price and 199g01s is not.
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
local function discountCell(value) return string.format("|cff55ff55-%.0f%%|r", value) end
local function countCell(value) return tostring(value) end

-- Four right-aligned slots, each holding exactly one quantity, so every
-- number is comparable straight down its column and sortable by its own
-- header. A mode with fewer columns pads from the left, which keeps money
-- in the same slots whichever list is showing.
local COL_COUNT = 4
local DEAL_COLUMNS = {
  { key = "discountPercent", label = "COL_DISC", cell = discountCell },
  { key = "profit", label = "COL_PROFIT", cell = moneyCell },
  { key = "minPrice", label = "TT_MIN", cell = moneyCell, asc = true },
  { key = "med7", label = "COL_REF", cell = moneyCell }
}
local RESULT_COLUMNS = {
  { key = "count", label = "COL_QTY", cell = countCell },
  { key = "unitPrice", label = "COL_UNIT", cell = moneyCell, asc = true },
  { key = "buyout", label = "COL_TOTAL", cell = moneyCell, asc = true }
}

local sortKey = nil -- nil = the current mode's default ordering
local sortAsc = false

local function columnAt(slot)
  local columns = mode == "deals" and DEAL_COLUMNS or RESULT_COLUMNS
  return columns[slot - (COL_COUNT - #columns)]
end

-- The default order carries the judgement the radar exists to make: vendor
-- deals first because they carry no market risk, then by absolute profit.
local function applySort()
  local rows = mode == "deals" and deals or results
  if not sortKey then
    if mode == "deals" then
      table.sort(rows, function(left, right)
        if left.vendor ~= right.vendor then return left.vendor end
        return left.profit > right.profit
      end)
    else
      table.sort(rows, function(left, right) return left.unitPrice < right.unitPrice end)
    end
    return
  end
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

-- ============================== Deal radar ============================

local function refreshDeals()
  wipe(deals)
  -- A rebuilt row set invalidates whichever column the user last sorted by.
  sortKey = nil
  local scan = currentScan()
  if not scan or not next(scan) then
    chatMessage(L.DEALS_NEED_SCAN)
    return
  end
  local anyHistory = false
  for itemId, entry in pairs(scan) do
    local history = WAH.history(itemId)
    if history then anyHistory = true end
    -- Class 1: vendor arbitrage. Listed below the NPC sell price is a
    -- guaranteed profit with zero market risk — no history needed, and no
    -- profit floor either: the NPC always buys.
    if entry.vendorP and entry.vendorP > 0 and entry.minPrice and entry.minPrice > 0
      and entry.minPrice < entry.vendorP then
      deals[#deals + 1] = {
        itemId = tonumber(itemId),
        name = entry.name,
        minPrice = entry.minPrice,
        med7 = entry.vendorP,
        profit = entry.vendorP - entry.minPrice,
        vendor = true,
        discountPercent = (1 - entry.minPrice / entry.vendorP) * 100
      }
    -- Class 2: P10 median discount. Requires history depth AND a live market
    -- AND a worthwhile absolute spread. The last two conditions distrust
    -- med7 itself: a flat series is one camper's ask, and a discount past
    -- the cap means the reference broke, not that the listing is cheap.
    elseif history and #history.pts >= WAH.RADAR.minHistory and history.med7 and history.med7 > 0
      and entry.minPrice and entry.minPrice > 0
      and (entry.numAuctions or 0) >= WAH.RADAR.minAuctions
      and (history.med7 - entry.minPrice) >= WAH.RADAR.minProfit
      and entry.minPrice <= history.med7 * WAH.RADAR.discount
      and (history.distinct or 0) >= WAH.RADAR.minMed7Distinct
      and entry.minPrice >= history.med7 * (1 - WAH.RADAR.maxDiscount) then
      deals[#deals + 1] = {
        itemId = tonumber(itemId),
        name = entry.name,
        minPrice = entry.minPrice,
        med7 = history.med7,
        profit = history.med7 - entry.minPrice,
        vendor = false,
        discountPercent = (1 - entry.minPrice / history.med7) * 100
      }
    end
  end
  if #deals == 0 and not anyHistory then
    chatMessage(L.DEALS_NEED_HISTORY)
    return
  end
  applySort()
  chatMessage(#deals == 0 and L.DEALS_NONE or string.format(L.DEALS_FOUND, #deals))
end

-- ============================== Buy side ==============================

local function itemKeyFor(itemId)
  return C_AuctionHouse.MakeItemKey(itemId, 0, 0, 0)
end

-- A price book row is either one item auction (auctionID, buyout) or one
-- commodity offer group (quantity at a unit price). Both render through the
-- same four columns; only the buy action differs.
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
-- the cost of buying N units is not N times any single row's price. Returns
-- nil when the visible book cannot fill the quantity.
local function commodityCost(quantity)
  local offers = {}
  for _, row in ipairs(results) do offers[#offers + 1] = row end
  table.sort(offers, function(left, right) return left.unitPrice < right.unitPrice end)
  local remaining, total = quantity, 0
  for _, offer in ipairs(offers) do
    local take = math.min(remaining, offer.count)
    total = total + take * offer.unitPrice
    remaining = remaining - take
    if remaining <= 0 then return total end
  end
  return nil
end

local runSearch -- forward declaration; buy-refresh and deal rows trigger searches

-- The radar reads the session scan as its record of what is listed right
-- now, and only a full rescan rewrites it — so buying the cheapest listing
-- left the scan advertising a price nobody can pay. The live result rows are
-- the one fresh evidence a session has; correct the entry from them.
--
-- Ceiling: those rows are one search's results, never the whole book, so the
-- price this lands on is never below the truth. It can hide a real deal
-- until the next scan; it can never invent one.
local function repriceAfterPurchase(bought)
  local scan = currentScan()
  local scanned = scan and scan[bought.itemId]
  if not scanned then return end
  local cheapest = nil
  for _, row in ipairs(results) do
    if row.itemId == bought.itemId and row.auctionID ~= bought.auctionID
      and (not cheapest or row.unitPrice < cheapest) then
      cheapest = row.unitPrice
    end
  end
  if not cheapest then
    -- Nothing of this item left in the live results: every number in the
    -- entry describes a book that no longer exists, and a zeroed minimum
    -- would read as "free" on the tooltip.
    scan[bought.itemId] = nil
    return
  end
  scanned.minPrice = cheapest
  scanned.numAuctions = math.max((scanned.numAuctions or 1) - 1, 0)
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
    local estimate = commodityCost(row.count)
    if not estimate then
      chatMessage(L.COMMODITY_NO_DEPTH)
      return
    end
    pendingCommodity = row
    C_AuctionHouse.StartCommoditiesPurchase(row.itemId, row.count)
    chatMessage(string.format(L.COMMODITY_STARTED, row.name, row.count,
      coinString(estimate)))
    -- A cancelled confirmation never fires PURCHASE_COMPLETED. Drop the
    -- pending row eventually so a later purchase cannot reprice this one.
    C_Timer.After(120, function()
      if pendingCommodity == row then pendingCommodity = nil end
    end)
    return
  end
  local info = C_AuctionHouse.GetAuctionInfoByID(row.auctionID)
  if not info or not info.buyoutAmount or info.buyoutAmount ~= row.buyout then
    chatMessage("|cffff5555" .. L.LISTING_CHANGED .. "|r")
    return
  end
  C_AuctionHouse.PlaceBid(row.auctionID, row.buyout)
  repriceAfterPurchase(row)
  chatMessage(string.format(L.BOUGHT, row.name, row.count, coinString(row.buyout)))
  -- Re-run the search after the bid settles so the bought listing drops off.
  C_Timer.After(0.6, function()
    if trade and trade:IsShown() and mode == "results" then runSearch() end
  end)
end

renderRows = function()
  if not trade then return end
  local rows = mode == "deals" and deals or results
  trade.headItem:SetText(L.COL_ITEM .. sortMark("name"))
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
        -- A radar row is built from scan data, so it has an item but no
        -- live auction to point a tooltip at.
        rowFrame.showTooltip = function() GameTooltip:SetHyperlink("item:" .. row.itemId) end
        rowFrame.name:SetText(row.vendor
          and string.format("%s |cffffd100[%s]|r", row.name, L.VENDOR_TAG)
          or row.name)
        rowFrame.buy:SetText(L.FIND)
        rowFrame.buy:SetScript("OnClick", function()
          trade.searchBox:SetText(row.name)
          searchState = nil
          searching = nil
          -- Radar rows carry the itemId, so they skip name resolution.
          WAH.searchItem(row.itemId, row.name)
        end)
      else
        rowFrame.icon:SetTexture(row.texture or WAH.itemIcon(row.itemId))
        rowFrame.showTooltip = function()
          GameTooltip:SetHyperlink(row.itemLink or ("item:" .. row.itemId))
        end
        rowFrame.name:SetText(row.name)
        rowFrame.buy:SetText(row.commodity and L.BUY_MARKET or L.BUY)
        rowFrame.buy:SetScript("OnClick", function() verifyAndBuy(row) end)
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

function WAH.searchItem(itemId, name)
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
    commodity = info.isCommodity
  }
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
-- match, and it avoids spending a browse query on every keystroke.
local function resolveFromScan(query)
  local scan = currentScan()
  if not scan then return nil end
  local needle = query:lower()
  local best, bestScore
  for itemId, entry in pairs(scan) do
    local name = (entry.name or ""):lower()
    local score
    if name == needle then
      score = 3
    elseif name:find(needle, 1, true) == 1 then
      score = 2
    elseif name:find(needle, 1, true) then
      score = 1
    end
    if score and (not bestScore or score > bestScore
      or (score == bestScore and #name < #best.name)) then
      best = { itemId = tonumber(itemId), name = entry.name }
      bestScore = score
    end
  end
  return best
end

runSearch = function()
  if not trade then return end
  if WAH.scanRunning then
    chatMessage(L.SCAN_WAIT)
    return
  end
  local query = trade.searchBox:GetText()
  if query == "" then return end
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
  -- then open the first item it returns.
  searching = "browse"
  searchState = nil
  mode = "results"
  C_AuctionHouse.SendBrowseQuery({
    searchString = query,
    sorts = { { sortOrder = Enum.AuctionHouseSortOrder.Price, reverseSort = false } }
  })
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

  trade.searchBox = CreateFrame("EditBox", "WoWderhoiAHTradeSearch", trade, "SearchBoxTemplate")
  trade.searchBox:SetSize(180, 20)
  trade.searchBox:SetPoint("TOPLEFT", PAD, -26)
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

  local searchButton = headerButton(L.SEARCH, trade.searchBox, 62, runSearch)
  local dealsButton = headerButton(L.FIND_DEALS, searchButton, 80, function()
    mode = "deals"
    refreshDeals()
    FauxScrollFrame_SetOffset(trade.scroll, 0)
    renderRows()
  end)
  local scanButton = headerButton(L.FULL_SCAN, dealsButton, 80, function()
    if WAH.startScan then WAH.startScan() end
  end)
  headerButton(L.OPTIONS, scanButton, 60, function() WAH.openSettings() end)

  -- Table header row: fixed columns, right-aligned numbers.
  local HEADER_Y = -54
  local COL_BUY_W, COL_W, COL_GAP = 60, 72, 6
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

  local ROWS_TOP = -72
  local TOP_INSET, BOTTOM_INSET = 70, 38
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
  refreshDeals()
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

tradeEvents:SetScript("OnEvent", function(_, event, payload)
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
    pendingCommodity = nil
    return
  end
  if event == "AUCTION_HOUSE_BROWSE_FAILURE" then
    if searching then
      searching = nil
      chatMessage(L.SEARCH_FAILED)
    end
    return
  end
  if event == "AUCTION_HOUSE_PURCHASE_COMPLETED" then
    if pendingCommodity then
      local bought = pendingCommodity
      pendingCommodity = nil
      repriceAfterPurchase(bought)
      C_Timer.After(0.6, function()
        if trade and trade:IsShown() and mode == "results" then runSearch() end
      end)
    end
    return
  end
  -- Browse resolution: the server answered a typed name search with a list
  -- of item keys; open the first one.
  if searching == "browse" and not searchState then
    -- The client returns browse results as an itemKey-indexed table on some
    -- builds and a plain array on others; pairs() reads both, and picking
    -- the cheapest match avoids depending on either order.
    local first
    for _, result in pairs(C_AuctionHouse.GetBrowseResults() or {}) do
      if result.itemKey and (not first
        or (result.minPrice or math.huge) < (first.minPrice or math.huge)) then
        first = result
      end
    end
    if not first then
      searching = nil
      chatMessage(L.SEARCH_FAILED)
      return
    end
    searching = nil
    WAH.searchItem(first.itemKey.itemID)
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
