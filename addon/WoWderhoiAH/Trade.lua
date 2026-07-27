-- WAH tab: deal radar plus buy list. The radar is the differentiated
-- feature — it crosses this session's scan against the in-game 7d
-- median to surface listings 15%+ below their usual price, something
-- neither Auctionator nor the stock UI can do.
--
-- Buy safety: the live row is re-read and name/count/price verified at
-- click time; any mismatch aborts with a rescan prompt. Sell posting
-- only prefills the stock UI price fields.

local ADDON_NAME, WAH = ...
local L = WAH.L

local ROWS_VISIBLE = 12
local ROW_HEIGHT = 22
local DEAL_DISCOUNT = 0.85 -- min price at 85% of med7 or lower

local trade = nil
local results = {} -- search rows: { index, itemId, name, count, buyout, unitPrice, texture }
local deals = {} -- radar rows: { itemId, name, minPrice, med7, discountPercent }
local mode = "deals" -- which list the scroll frame renders
local searching = false

local function chatMessage(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WAH|r " .. text)
end

-- ============================== Deal radar ============================

local MIN_AUCTIONS = 3 -- liquidity guard: fewer sellers = no real market
local MIN_PROFIT = 500 -- 5s absolute floor; sub-silver "deals" waste a trip

local function refreshDeals()
  wipe(deals)
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
    -- Class 2: median discount. Requires history depth (3+ scans) AND a
    -- live market (3+ auctions) AND a worthwhile absolute spread —
    -- otherwise the list fills with illiquid junk nobody ever buys.
    elseif history and #history.pts >= 3 and history.med7 and history.med7 > 0
      and entry.minPrice and entry.minPrice > 0
      and (entry.numAuctions or 0) >= MIN_AUCTIONS
      and (history.med7 - entry.minPrice) >= MIN_PROFIT
      and entry.minPrice <= history.med7 * DEAL_DISCOUNT then
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
  -- Vendor deals first (risk-free), then by absolute profit.
  table.sort(deals, function(left, right)
    if left.vendor ~= right.vendor then return left.vendor end
    return left.profit > right.profit
  end)
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
  table.sort(results, function(left, right) return left.unitPrice < right.unitPrice end)
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

local function renderRows()
  if not trade then return end
  local rows = mode == "deals" and deals or results
  -- Column headers follow the mode.
  if mode == "deals" then
    trade.headDisc:SetText(L.COL_DISC)
    trade.headA:SetText(L.TT_MIN)
    trade.headB:SetText(L.TT_MED7)
  else
    trade.headDisc:SetText("")
    trade.headA:SetText(L.COL_UNIT)
    trade.headB:SetText(L.COL_TOTAL)
  end
  local offset = FauxScrollFrame_GetOffset(trade.scroll)
  FauxScrollFrame_Update(trade.scroll, #rows, ROWS_VISIBLE, ROW_HEIGHT)
  for rowIndex = 1, ROWS_VISIBLE do
    local rowFrame = trade.rows[rowIndex]
    local row = rows[rowIndex + offset]
    if row and mode == "deals" then
      rowFrame.icon:SetTexture(GetItemIcon(row.itemId))
      if row.vendor then
        rowFrame.name:SetText(string.format("%s |cffffd100[%s]|r", row.name, L.VENDOR_TAG))
        rowFrame.disc:SetText(string.format("|cffffd100+%s|r", GetCoinTextureString(row.profit)))
      else
        rowFrame.name:SetText(row.name)
        rowFrame.disc:SetText(string.format("|cff55ff55-%.0f%%|r", row.discountPercent))
      end
      rowFrame.colA:SetText(GetCoinTextureString(row.minPrice))
      rowFrame.colB:SetText(GetCoinTextureString(row.med7))
      rowFrame.buy:SetText(L.FIND)
      rowFrame.buy:SetScript("OnClick", function()
        trade.searchBox:SetText(row.name)
        runSearch()
      end)
      rowFrame:Show()
    elseif row then
      rowFrame.icon:SetTexture(row.texture)
      rowFrame.name:SetText(string.format("%s x%d", row.name, row.count))
      rowFrame.disc:SetText("")
      rowFrame.colA:SetText(GetCoinTextureString(math.floor(row.unitPrice + 0.5)))
      rowFrame.colB:SetText(GetCoinTextureString(row.buyout))
      rowFrame.buy:SetText(L.BUY)
      rowFrame.buy:SetScript("OnClick", function() verifyAndBuy(row) end)
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
  trade = CreateFrame("Frame", "WoWderhoiAHTrade", AuctionFrame)
  trade:SetPoint("TOPLEFT", AuctionFrame, "TOPLEFT", 22, -70)
  trade:SetPoint("BOTTOMRIGHT", AuctionFrame, "BOTTOMRIGHT", -10, 38)

  trade.title = trade:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  trade.title:SetPoint("TOPLEFT", 0, -2)
  trade.title:SetText(L.TRADE_TITLE)

  trade.searchBox = CreateFrame("EditBox", "WoWderhoiAHTradeSearch", trade, "SearchBoxTemplate")
  trade.searchBox:SetSize(180, 20)
  trade.searchBox:SetPoint("TOPLEFT", 4, -22)
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
  local HEADER_Y = -50
  local COL_BUY_W, COL_PRICE_W, COL_DISC_W = 60, 130, 96
  trade.headItem = trade:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  trade.headItem:SetPoint("TOPLEFT", 26, HEADER_Y)
  trade.headItem:SetText(L.COL_ITEM)
  trade.headDisc = trade:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  trade.headDisc:SetPoint("TOPRIGHT", trade, "TOPRIGHT", -(24 + COL_BUY_W + 8 + 2 * (COL_PRICE_W + 8)), HEADER_Y)
  trade.headDisc:SetWidth(COL_DISC_W)
  trade.headDisc:SetJustifyH("RIGHT")
  trade.headA = trade:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  trade.headA:SetPoint("TOPRIGHT", trade, "TOPRIGHT", -(24 + COL_BUY_W + 8 + COL_PRICE_W + 8), HEADER_Y)
  trade.headA:SetWidth(COL_PRICE_W)
  trade.headA:SetJustifyH("RIGHT")
  trade.headB = trade:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  trade.headB:SetPoint("TOPRIGHT", trade, "TOPRIGHT", -(24 + COL_BUY_W + 8), HEADER_Y)
  trade.headB:SetWidth(COL_PRICE_W)
  trade.headB:SetJustifyH("RIGHT")
  local headerLine = trade:CreateTexture(nil, "ARTWORK")
  headerLine:SetColorTexture(0.6, 0.5, 0.3, 0.6)
  headerLine:SetPoint("TOPLEFT", 0, HEADER_Y - 14)
  headerLine:SetPoint("TOPRIGHT", -24, HEADER_Y - 14)
  headerLine:SetHeight(1)

  local ROWS_TOP = -68
  trade.scroll = CreateFrame("ScrollFrame", "WoWderhoiAHTradeScroll", trade, "FauxScrollFrameTemplate")
  trade.scroll:SetPoint("TOPLEFT", 0, ROWS_TOP)
  trade.scroll:SetPoint("BOTTOMRIGHT", -24, 2)
  trade.scroll:SetScript("OnVerticalScroll", function(self, delta)
    FauxScrollFrame_OnVerticalScroll(self, delta, ROW_HEIGHT, renderRows)
  end)

  trade.rows = {}
  for rowIndex = 1, ROWS_VISIBLE do
    local rowFrame = CreateFrame("Frame", nil, trade)
    rowFrame:SetHeight(ROW_HEIGHT)
    rowFrame:SetPoint("TOPLEFT", 0, ROWS_TOP - (rowIndex - 1) * ROW_HEIGHT)
    rowFrame:SetPoint("TOPRIGHT", trade, "TOPRIGHT", -24, ROWS_TOP - (rowIndex - 1) * ROW_HEIGHT)
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
    rowFrame.icon:SetSize(18, 18)
    rowFrame.icon:SetPoint("LEFT", 4, 0)
    rowFrame.buy = CreateFrame("Button", nil, rowFrame, "UIPanelButtonTemplate")
    rowFrame.buy:SetSize(COL_BUY_W, 18)
    rowFrame.buy:SetPoint("RIGHT", 0, 0)
    rowFrame.colB = rowFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    rowFrame.colB:SetPoint("RIGHT", rowFrame.buy, "LEFT", -8, 0)
    rowFrame.colB:SetWidth(COL_PRICE_W)
    rowFrame.colB:SetJustifyH("RIGHT")
    rowFrame.colA = rowFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    rowFrame.colA:SetPoint("RIGHT", rowFrame.colB, "LEFT", -8, 0)
    rowFrame.colA:SetWidth(COL_PRICE_W)
    rowFrame.colA:SetJustifyH("RIGHT")
    rowFrame.disc = rowFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    rowFrame.disc:SetPoint("RIGHT", rowFrame.colA, "LEFT", -8, 0)
    rowFrame.disc:SetWidth(COL_DISC_W)
    rowFrame.disc:SetJustifyH("RIGHT")
    rowFrame.name = rowFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    rowFrame.name:SetPoint("LEFT", rowFrame.icon, "RIGHT", 6, 0)
    rowFrame.name:SetPoint("RIGHT", rowFrame.disc, "LEFT", -8, 0)
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
          -- The stock handler swaps the frame's six backdrop slices only
          -- for tabs 1-3; for ours it leaves the previous tab's art
          -- behind (e.g. Browse's filter column). Use the full-width
          -- Auctions art, the same set the stock Auctions tab uses.
          for _, slice in ipairs({ "TopLeft", "Top", "TopRight", "BotLeft", "Bot", "BotRight" }) do
            local region = _G["AuctionFrame" .. slice]
            if region then
              region:SetTexture("Interface\\AuctionFrame\\UI-AuctionFrame-Auction-" .. slice)
            end
          end
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
