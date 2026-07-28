-- WAH tab: deal radar plus buy list. The radar is the differentiated
-- feature — it crosses this session's scan against the in-game 7d P10
-- median to surface listings 15%+ below their usual price, something
-- neither Auctionator nor the stock UI can do.
--
-- Buy safety: the live row is re-read and name/count/price verified at
-- click time; any mismatch aborts with a rescan prompt. Sell posting
-- only prefills the stock UI price fields.

local ADDON_NAME, WAH = ...
local L = WAH.L

local ROWS_VISIBLE = 12 -- replaced in createTradeFrame by what the panel actually fits
local ROW_HEIGHT = 22
-- The backdrop draws its border art inside the frame's own bounds, so a
-- child anchored at the edge is painted on the bevel. Every child keeps PAD
-- clear of all four sides; PAD is wider than the backdrop's declared inset
-- because the dialog-box border's visible bevel runs past it.
local PAD = 8
-- Deal-radar thresholds live in WAH.RADAR (GeneratedRules.lua, compiled from
-- src/lib/market-rules.ts) so the in-game radar and the desktop terminal
-- classify every scan identically.

local trade = nil
local results = {} -- search rows: { index, itemId, name, count, buyout, unitPrice, texture }
local deals = {} -- radar rows: { itemId, name, minPrice, med7, discountPercent }
local mode = "deals" -- which list the scroll frame renders
local searching = false

local function chatMessage(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WAH|r " .. text)
end

-- ============================ Table model =============================

-- Compact money. GetCoinTextureString always prints all three units with
-- inline coin icons, so no two prices in a column line up and 24s31c of
-- noise crowds out the gold that actually decides the trade. Two units is
-- everything anyone acts on; the third never changes a decision.
-- Deliberately keeps the silver that formatWowMoney's compact mode drops
-- past 100g: 199g99s is a bait price and 199g01s is not, and the radar
-- exists to make exactly that difference visible.
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

-- The default order carries the judgement the radar exists to make:
-- vendor deals first because they carry no market risk, then by absolute
-- profit. Clicking any header drops that tiering for a plain one-column
-- sort — the user has taken over the ranking at that point.
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
  local scan = WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.dataVersion == WAH.PIPELINE_VERSION and WoWderhoiAH_ScanData.items
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
    -- profit floor either: the NPC always buys, so even a 1c spread is
    -- free money the moment you're already at the AH.
    if entry.vendorP and entry.vendorP > 0 and entry.minPrice and entry.minPrice > 0
      and entry.minPrice < entry.vendorP then
      deals[#deals + 1] = {
        itemId = itemId,
        name = entry.name,
        minPrice = entry.minPrice,
        med7 = entry.vendorP,
        profit = entry.vendorP - entry.minPrice,
        vendor = true,
        discountPercent = (1 - entry.minPrice / entry.vendorP) * 100
      }
    -- Class 2: P10 median discount. Requires history depth (3+ scans) AND a
    -- live market (3+ auctions) AND a worthwhile absolute spread —
    -- otherwise the list fills with illiquid junk nobody ever buys. The
    -- last two conditions distrust med7 itself: a flat series is one
    -- camper's ask, and a discount past the cap means the reference broke,
    -- not that the listing is cheap. Neither applies to vendor deals above.
    elseif history and #history.pts >= WAH.RADAR.minHistory and history.med7 and history.med7 > 0
      and entry.minPrice and entry.minPrice > 0
      and (entry.numAuctions or 0) >= WAH.RADAR.minAuctions
      and (history.med7 - entry.minPrice) >= WAH.RADAR.minProfit
      and entry.minPrice <= history.med7 * WAH.RADAR.discount
      and (history.distinct or 0) >= WAH.RADAR.minMed7Distinct
      and entry.minPrice >= history.med7 * (1 - WAH.RADAR.maxDiscount) then
      deals[#deals + 1] = {
        itemId = itemId,
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

local function collectSearchResults()
  wipe(results)
  local numOnPage = GetNumAuctionItems("list")
  for index = 1, numOnPage do
    -- buyoutPrice is the 10th return; the 9th is minIncrement, which is
    -- 0 on no-bid auctions and silently empties the list if misread.
    local name, texture, count, _, _, _, _, _, _, buyoutPrice = GetAuctionItemInfo("list", index)
    local link = GetAuctionItemLink("list", index)
    local itemId = link and tonumber(link:match("item:(%d+)"))
    if itemId and name and buyoutPrice and buyoutPrice > 0 and count and count > 0 then
      results[#results + 1] = {
        index = index,
        itemId = itemId,
        name = name,
        count = count,
        buyout = buyoutPrice,
        unitPrice = buyoutPrice / count,
        texture = texture
      }
    end
  end
  sortKey = nil
  applySort()
end

local runSearch -- forward declaration; buy-refresh and deal rows trigger searches

local function verifyAndBuy(row)
  local name, _, count, _, _, _, _, _, _, buyoutPrice = GetAuctionItemInfo("list", row.index)
  if name ~= row.name or count ~= row.count or buyoutPrice ~= row.buyout then
    chatMessage("|cffff5555" .. L.LISTING_CHANGED .. "|r")
    return
  end
  PlaceAuctionBid("list", row.index, row.buyout)
  chatMessage(string.format(L.BOUGHT, row.name, row.count, GetCoinTextureString(row.buyout)))
  -- Re-run the search after the bid settles so the bought listing drops
  -- off. Route through runSearch (not a raw query) so the searching flag
  -- is set — the list handler ignores updates when it is not, which is
  -- why a raw re-query here never refreshed the rows.
  C_Timer.After(0.6, function()
    if trade and trade:IsShown() and trade.lastQuery then runSearch() end
  end)
end

renderRows = function()
  if not trade then return end
  local rows = mode == "deals" and deals or results
  -- Headers follow the mode, and carry the sort marker for the live key.
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
        rowFrame.icon:SetTexture(GetItemIcon(row.itemId))
        -- Risk class rides on the name, not on a number column: vendor
        -- profit is guaranteed, a median discount is an estimate, and
        -- mixing the two into one cell is what made the old column unreadable.
        rowFrame.name:SetText(row.vendor
          and string.format("%s |cffffd100[%s]|r", row.name, L.VENDOR_TAG)
          or row.name)
        rowFrame.buy:SetText(L.FIND)
        rowFrame.buy:SetScript("OnClick", function()
          trade.searchBox:SetText(row.name)
          runSearch()
        end)
      else
        rowFrame.icon:SetTexture(row.texture)
        rowFrame.name:SetText(row.name)
        rowFrame.buy:SetText(L.BUY)
        rowFrame.buy:SetScript("OnClick", function() verifyAndBuy(row) end)
      end
      rowFrame:Show()
    else
      rowFrame:Hide()
    end
  end
end

runSearch = function()
  if not trade then return end
  if WAH.scanRunning then
    chatMessage(L.SCAN_WAIT)
    return
  end
  local query = trade.searchBox:GetText()
  if query == "" then return end
  if not CanSendAuctionQuery() then
    chatMessage(L.THROTTLED)
    C_Timer.After(0.4, runSearch)
    return
  end
  searching = true
  trade.lastQuery = query
  QueryAuctionItems(query, nil, nil, 0, false, -1, false, false)
end

-- ============================== Sell side =============================

-- Sell anchor: the depth-aware front (sellP) beats the raw minimum —
-- undercutting a lone dump listing gives gold away; undercutting where
-- real depth starts puts you first in the queue that matters.
local function sessionUnitPrice(itemId)
  local scanned = WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.dataVersion == WAH.PIPELINE_VERSION
    and WoWderhoiAH_ScanData.items and WoWderhoiAH_ScanData.items[itemId]
  if scanned and (scanned.sellP or scanned.minPrice) then
    return scanned.sellP or scanned.minPrice, "scan"
  end
  local history = WAH.history(itemId)
  if history and history.latest then return history.latest, "history" end
  return nil
end

local sellHook = CreateFrame("Frame")
sellHook:RegisterEvent("NEW_AUCTION_UPDATE")
sellHook:SetScript("OnEvent", function()
  if not (AuctionFrame and AuctionFrame:IsShown()) then return end
  local name, _, count = GetAuctionSellItemInfo()
  if not name or not count or count == 0 then return end
  local link = GetAuctionSellItemLink and GetAuctionSellItemLink()
  local itemId = link and tonumber(link:match("item:(%d+)"))
  if not itemId then return end
  local unitPrice, source = sessionUnitPrice(itemId)
  if not unitPrice then
    chatMessage(string.format(L.SELL_NO_DATA, name))
    return
  end
  local buyoutTotal = math.max((unitPrice - 1) * count, count)
  -- Start bid at 95% of buyout: flat heuristic, replace with a
  -- fill-rate-informed ratio once sale tracking lands.
  local startTotal = math.max(math.floor(buyoutTotal * 0.95), 1)
  MoneyInputFrame_SetCopper(BuyoutPrice, buyoutTotal)
  MoneyInputFrame_SetCopper(StartPrice, startTotal)
  chatMessage(string.format(L.SELL_PREFILLED, name, count, GetCoinTextureString(buyoutTotal), source))
end)

-- ============================== Frame =================================

local function createTradeFrame()
  trade = CreateFrame("Frame", "WoWderhoiAHTrade", AuctionFrame, "BackdropTemplate")
  -- Named because the row count is derived from what these two leave over.
  local TOP_INSET, BOTTOM_INSET = 70, 38
  trade:SetPoint("TOPLEFT", AuctionFrame, "TOPLEFT", 22, -TOP_INSET)
  trade:SetPoint("BOTTOMRIGHT", AuctionFrame, "BOTTOMRIGHT", -10, BOTTOM_INSET)
  -- Own opaque panel: without it the transparent frame shows whatever art
  -- the previously active tab left behind — Blizzard's or, when Auctionator
  -- is loaded, its independently rendered background. Sit above the AH so
  -- our page owns every pixel it covers instead of borrowing shared slices.
  trade:SetFrameLevel(AuctionFrame:GetFrameLevel() + 10)
  trade:SetBackdrop({
    bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
    edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile = true, tileSize = 32, edgeSize = 20,
    insets = { left = 5, right = 5, top = 5, bottom = 5 }
  })

  trade.title = trade:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  trade.title:SetPoint("TOPLEFT", PAD, -PAD)
  trade.title:SetText(L.TRADE_TITLE)

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

  local searchButton = headerButton(L.SEARCH, trade.searchBox, 70, function()
    mode = "results"
    runSearch()
  end)
  local dealsButton = headerButton(L.FIND_DEALS, searchButton, 90, function()
    mode = "deals"
    refreshDeals()
    FauxScrollFrame_SetOffset(trade.scroll, 0)
    renderRows()
  end)
  local scanButton = headerButton(L.FULL_SCAN, dealsButton, 90, function()
    if WAH.startScan then WAH.startScan() end
  end)
  headerButton(L.OPTIONS, scanButton, 70, function() WAH.openSettings() end)

  -- Table header row: fixed columns, right-aligned numbers. Price
  -- columns are fixed-width so long values can never collide with the
  -- item name, which truncates with an ellipsis instead of overflowing.
  local HEADER_Y = -54
  local COL_BUY_W, COL_W, COL_GAP = 60, 92, 8
  local SCROLL_W = 24 -- right gutter the FauxScrollFrame's bar occupies
  local ICON_X, ICON_W, NAME_GAP = 4, 18, 6 -- row art; the item header aligns to the name
  -- FontStrings take no clicks, so a header is a label plus a transparent
  -- button covering it; the label keeps the anchor, width and
  -- justification the whole layout is built on. Which column a slot holds
  -- is resolved at click time because it follows the current mode.
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
    -- Fixed width in a fixed-height row: wrapping would push a second line
    -- onto the row below, so a long label truncates instead.
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
  -- Whatever the panel has left after the header block, minus the bottom
  -- border. Hardcoding 12 is what put the last row on the frame's edge:
  -- AuctionFrame is 447 tall, this page keeps 70 above and 38 below, and
  -- 12 rows of 22 overran what remained by all but 7px.
  local rowSpace = (AuctionFrame:GetHeight() or 447) - TOP_INSET - BOTTOM_INSET + ROWS_TOP - PAD
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
    -- Zebra shading + a hairline separator under every row.
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
      cell:SetWordWrap(false) -- a wrapped value would grow past ROW_HEIGHT
      rowFrame.cells[slot] = cell
      anchor = cell
    end
    rowFrame.name = rowFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    rowFrame.name:SetPoint("LEFT", rowFrame.icon, "RIGHT", NAME_GAP, 0)
    rowFrame.name:SetPoint("RIGHT", rowFrame.cells[1], "LEFT", -COL_GAP, 0)
    rowFrame.name:SetJustifyH("LEFT")
    rowFrame.name:SetWordWrap(false) -- long names truncate with an ellipsis
    rowFrame:Hide()
    trade.rows[rowIndex] = rowFrame
  end
  trade:Hide()
end

local function registerAuctionTab()
  if WAH.tradeTabId or not AuctionFrame then return end
  local ok, err = pcall(function()
    -- Auctionator and other addons insert their own AuctionFrameTabN
    -- frames; pick the first free index so a name collision can never
    -- clobber or hide our tab.
    local tabIndex = AuctionFrame.numTabs + 1
    while _G["AuctionFrameTab" .. tabIndex] do tabIndex = tabIndex + 1 end
    local lastTab
    for index = tabIndex - 1, 1, -1 do
      lastTab = _G["AuctionFrameTab" .. index]
      if lastTab then break end
    end
    local tab = CreateFrame("Button", "AuctionFrameTab" .. tabIndex, AuctionFrame, "AuctionTabTemplate")
    tab:SetID(tabIndex)
    tab:SetText("WAH")
    if lastTab then
      tab:SetPoint("LEFT", lastTab, "RIGHT", -8, 0)
    else
      tab:SetPoint("BOTTOMLEFT", AuctionFrame, "BOTTOMLEFT", 15, -30)
    end
    PanelTemplates_SetNumTabs(AuctionFrame, tabIndex)
    PanelTemplates_EnableTab(AuctionFrame, tabIndex)
    WAH.tradeTabId = tabIndex

    -- Hook tab switching only now: AuctionFrameTab_OnClick does not
    -- exist until Blizzard_AuctionUI loads, and hooking it at file
    -- scope kills this whole file with a load error.
    if type(AuctionFrameTab_OnClick) == "function" then
      hooksecurefunc("AuctionFrameTab_OnClick", function(clickedTab)
        if not trade then return end
        if clickedTab and clickedTab:GetID() == WAH.tradeTabId then
          AuctionFrameBrowse:Hide()
          AuctionFrameBid:Hide()
          AuctionFrameAuctions:Hide()
          trade:Show()
          -- Deal radar is the landing view; refresh it on entry.
          mode = "deals"
          refreshDeals()
          FauxScrollFrame_SetOffset(trade.scroll, 0)
          renderRows()
        else
          trade:Hide()
        end
      end)
    end
    -- Addon-driven tab switches (Auctionator) bypass that click
    -- handler; showing any stock pane must also dismiss our page.
    for _, pane in ipairs({ AuctionFrameBrowse, AuctionFrameBid, AuctionFrameAuctions }) do
      if pane then pane:HookScript("OnShow", function() if trade then trade:Hide() end end) end
    end
    chatMessage(string.format(L.TAB_READY, tabIndex))
  end)
  if not ok then
    chatMessage("|cffff5555" .. L.TAB_FAILED .. tostring(err) .. "|r")
  end
end

local tradeEvents = CreateFrame("Frame")
tradeEvents:RegisterEvent("AUCTION_HOUSE_SHOW")
tradeEvents:RegisterEvent("AUCTION_HOUSE_CLOSED")
tradeEvents:RegisterEvent("AUCTION_ITEM_LIST_UPDATE")
tradeEvents:SetScript("OnEvent", function(_, event)
  if event == "AUCTION_HOUSE_SHOW" then
    if not trade and AuctionFrame then createTradeFrame() end
    -- Delay registration past other addons' tab creation (Auctionator
    -- builds its tabs during the same load window).
    C_Timer.After(0.5, registerAuctionTab)
  elseif event == "AUCTION_HOUSE_CLOSED" then
    if trade then trade:Hide() end
    searching = false
  elseif event == "AUCTION_ITEM_LIST_UPDATE" and searching then
    -- Ignore list updates from full scans; only react to our own search.
    searching = false
    mode = "results"
    collectSearchResults()
    FauxScrollFrame_SetOffset(trade.scroll, 0)
    renderRows()
    chatMessage(string.format(L.N_LISTINGS, #results))
  end
end)
