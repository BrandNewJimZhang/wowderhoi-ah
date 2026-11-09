-- Sell page: the other half of the loop.
--
-- Buying is only useful if the goods leave the bag. This panel lists what
-- the player can sell, prices it against the current sell front, charges
-- the client's own deposit and fee arithmetic, and posts through
-- C_AuctionHouse.PostItem / PostCommodity. Every successful posting,
-- cancellation and expiry becomes a journal event, which is what turns
-- the ledger from a hypothetical into a P&L record.
--
-- The posting calls are marked HasRestrictions in the 1.60 documentation.
-- When the client blocks one (ADDON_ACTION_BLOCKED / FORBIDDEN), the panel
-- degrades to a price assistant: it prints the exact price to type and
-- never pretends the listing exists.

local ADDON_NAME, WAH = ...
local L = WAH.L
local coinString = WAH.coinString

local PANEL_WIDTH, PANEL_HEIGHT = 600, 540
local PAD = 8
local ROW_HEIGHT = 22
local BAG_ROWS = 8
local OWNED_ROWS = 10
local DURATIONS = { 12, 24, 48 }
-- How far above the sell front an owned listing must sit before it counts
-- as undercut. A tiny gap is noise from the one-copper listing rule, so the
-- tolerance is a compiled market rule rather than a literal here.
local UNDERCUT_WARN_RATIO = (WAH.RULES.sellFront and WAH.RULES.sellFront.undercutWarnRatio) or 0.02

local sell = nil
local mode = "sell"
local bagItems = {}
local selected = nil
local owned = {}
local ownedLoaded = false
-- True only after the client answered QueryOwnedAuctions. Before that the
-- owned list is merely "whatever was last rendered", and treating its holes
-- as sales would book every open posting as sold the first time the page
-- opens.
local ownedSynced = false
local pendingPost = nil
local cancelling = {}
local lastError = nil
local selectedDuration = 24

local function chatMessage(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WAH|r " .. text)
end

local function locationFor(entry)
  if entry.location then return entry.location end
  if ItemLocation and ItemLocation.CreateFromBagAndSlot then
    entry.location = ItemLocation:CreateFromBagAndSlot(entry.bag, entry.slot)
  end
  return entry.location
end

local function isCommodity(entry)
  local itemKey = C_AuctionHouse.MakeItemKey(entry.itemId, 0, 0, 0)
  local info = C_AuctionHouse.GetItemKeyInfo and C_AuctionHouse.GetItemKeyInfo(itemKey)
  if info and info.isCommodity ~= nil then return info.isCommodity and true or false end
  local location = locationFor(entry)
  if C_AuctionHouse.GetItemCommodityStatus and location
    and Enum and Enum.ItemCommodityStatus then
    return C_AuctionHouse.GetItemCommodityStatus(location) == Enum.ItemCommodityStatus.Commodity
  end
  return false
end

local function depositFor(entry, duration, quantity)
  if entry.commodity then
    if C_AuctionHouse.CalculateCommodityDeposit then
      local deposit = C_AuctionHouse.CalculateCommodityDeposit(entry.itemId, duration, quantity)
      return deposit or 0, deposit ~= nil
    end
  else
    local location = locationFor(entry)
    if location and C_AuctionHouse.CalculateItemDeposit then
      local deposit = C_AuctionHouse.CalculateItemDeposit(location, duration, quantity)
      return deposit or 0, deposit ~= nil
    end
  end
  return 0, false
end

-- ============================== Bag model =============================

local function collectBag()
  wipe(bagItems)
  local byItem = {}
  for bag = 0, 4 do
    local slots = C_Container and C_Container.GetContainerNumSlots and C_Container.GetContainerNumSlots(bag) or 0
    for slot = 1, slots do
      local info = C_Container and C_Container.GetContainerItemInfo
        and C_Container.GetContainerItemInfo(bag, slot)
      if info and info.itemID and (info.stackCount or 0) > 0 then
        local entry = byItem[info.itemID]
        if not entry then
          entry = {
            itemId = info.itemID,
            name = info.itemName or ("item:" .. info.itemID),
            icon = info.iconFileID,
            count = 0,
            bag = bag,
            slot = slot
          }
          entry.commodity = isCommodity(entry)
          byItem[info.itemID] = entry
        end
        entry.count = entry.count + info.stackCount
      end
    end
  end
  for _, entry in pairs(byItem) do bagItems[#bagItems + 1] = entry end
  table.sort(bagItems, function(left, right) return left.name < right.name end)
  if not selected or not byItem[selected.itemId] then selected = bagItems[1] end
  return bagItems
end

-- ============================== Pricing ==============================

-- The sell plan is Core.sellPlan; this function only supplies the inputs
-- the core cannot know: the client's deposits and the ledger's cost basis
-- for the units being sold. The fill hazard comes from the same estimator
-- the radar uses, so the price search and the radar cannot disagree about
-- how fast this item moves.
local function planFor(itemId, duration, quantity)
  local entry
  for _, candidate in ipairs(bagItems) do
    if candidate.itemId == itemId then entry = candidate break end
  end
  entry = entry or { itemId = itemId }
  local scanned = WAH.currentScanItems()[itemId]
  if not scanned or not (scanned.sellP and scanned.sellP > 0) then
    return nil, "noScan", entry
  end
  local qty = math.max(1, math.floor(quantity or entry.count or 1))
  local deposits, depositAvailable = {}, false
  for _, hours in ipairs(DURATIONS) do
    local deposit, available = depositFor(entry, hours, qty)
    deposits[hours] = deposit
    if available then depositAvailable = true end
  end
  local position = { qty = qty, cost = 0 }
  local ledger = WAH.Ledger and WAH.Ledger.current()
  local held = ledger and ledger.positions and ledger.positions[itemId]
  if held and held.qty and held.qty > 0 then
    -- The player may be selling more than the ledger booked (items from
    -- before the addon was installed); cost per unit stays the booked one.
    position.cost = held.cost / held.qty * qty
  end
  local opts = { deposit = deposits[duration or selectedDuration] or 0,
    deposits = deposits, duration = duration or selectedDuration }
  if WAH.settings and WAH.settings.pricing ~= false then
    local ownSales = WAH.Ledger and WAH.Ledger.salesSince and WAH.Ledger.salesSince() or {}
    local own = ownSales[itemId]
    local _, _, _, basis, hazard = WAH.Core.fillProbability({
      horizonHours = (WAH.RULES.fill and WAH.RULES.fill.horizonHours) or 24,
      phase = WAH.currentPhase and WAH.currentPhase() or "steady",
      marketType = scanned.marketType or WAH.Core.marketTypeFor(scanned),
      qty = qty,
      ownSold = own and own.qty or 0,
      ownSamples = own and own.samples or 0,
      ownExposedHours = own and own.exposedHours or 0,
      sold = scanned.inferredSoldLow or 0,
      supply = scanned.quantity or 0,
      elapsedHours = scanned.elapsedHours or ((WAH.RULES.scanIntervalMinutes or 15) / 60),
      observable = WAH.Core.isObservable(scanned)
    })
    -- Only item-specific evidence earns a re-priced listing. A phase-wide
    -- prior knows nothing about this book's queue, and searching price and
    -- duration on it would dress a guess up as an optimum.
    if basis ~= "prior" then
      -- The queue model needs the other sellers' ladder; own listings are
      -- already out of it.
      opts.hazard = hazard
      opts.supply = scanned.quantity
      opts.tiers = scanned.tiers
    end
  end
  local plan = WAH.Core.sellPlan({
    itemId = itemId,
    sellP = scanned.sellP,
    vendorP = scanned.vendorP
  }, position, WAH.RULES, opts)
  if not plan then return nil, "noPrice", entry end
  plan.depositAvailable = depositAvailable
  return plan, nil, entry
end

-- ============================== Posting =============================

local function onAuctionCreated(auctionID)
  if not auctionID then return end
  local post = pendingPost
  pendingPost = nil
  local recorded = WAH.Actions and WAH.Actions.post(auctionID, post)
  if post and recorded then
    chatMessage(string.format(L.SELL_POSTED, post.name, post.qty, coinString(post.price)))
  end
  if sell then
    C_Timer.After(1, function() WAH.Sell.refreshOwned() end)
  end
end

local function onAuctionExpired(auctionID)
  if not auctionID then return end
  if WAH.Actions then WAH.Actions.expire(auctionID) end
  chatMessage(string.format(L.SELL_EXPIRED, auctionID))
  if sell and sell:IsShown() then WAH.Sell.refreshOwned() end
end

local function postFailure(entry, plan, message)
  pendingPost = nil
  lastError = tostring(message)
  chatMessage(string.format(L.SELL_POST_FAILED, entry.name,
    coinString(plan and plan.listP or 0), tostring(message)))
  return false, lastError
end

local function postItem(itemId, duration, quantity)
  local plan, why, entry = planFor(itemId, duration, quantity)
  if not plan then
    chatMessage(string.format(L.SELL_NO_DATA, entry and entry.name or tostring(itemId)))
    return false, why
  end
  local location = locationFor(entry)
  if not location then
    chatMessage(string.format(L.SELL_NO_LOCATION, coinString(plan.listP)))
    return false, "noLocation"
  end
  local qty = plan.quantity
  -- The search may have chosen a shorter or longer listing than the button
  -- the player last pressed; post the plan that was shown.
  local durationValue = plan.duration or duration or selectedDuration
  pendingPost = {
    itemId = itemId,
    name = entry.name,
    qty = qty,
    price = plan.listP,
    deposit = plan.deposit
  }
  local ok, needsConfirmation = pcall(function()
    if entry.commodity then
      return C_AuctionHouse.PostCommodity(location, durationValue, qty, plan.listP)
    end
    return C_AuctionHouse.PostItem(location, durationValue, qty, nil, plan.listP)
  end)
  if not ok then return postFailure(entry, plan, needsConfirmation) end
  if needsConfirmation then
    local confirmed = pcall(function()
      if entry.commodity then
        return C_AuctionHouse.ConfirmPostCommodity(location, durationValue, qty, plan.listP)
      end
      return C_AuctionHouse.ConfirmPostItem(location, durationValue, qty, nil, plan.listP)
    end)
    if not confirmed then return postFailure(entry, plan, "confirmFailed") end
  end
  -- Some client builds create the auction synchronously and fire the event
  -- before PostItem returns; on those, pendingPost was consumed already.
  return true, plan
end

-- ============================== Owned ===============================

local function collectOwned()
  wipe(owned)
  for _, row in ipairs(WAH.ownedAuctions and WAH.ownedAuctions() or {}) do
    local quantity = row.quantity or 1
    local buyout = row.buyout or 0
    local unitPrice = quantity > 0 and buyout / quantity or 0
    local scanned = WAH.currentScanItems()[row.itemId]
    local sellP = scanned and scanned.sellP
    local seconds = row.timeLeftSeconds
    local name = WAH.getItemInfo(row.itemId) or tostring(row.itemId)
    owned[#owned + 1] = {
      auctionID = row.auctionID,
      itemId = row.itemId,
      name = name,
      quantity = quantity,
      unitPrice = unitPrice,
      buyout = buyout,
      timeLeftSeconds = seconds,
      undercut = sellP and sellP > 0 and unitPrice > sellP * (1 + UNDERCUT_WARN_RATIO) or false,
      status = row.status
    }
  end
  table.sort(owned, function(left, right)
    if left.timeLeftSeconds == right.timeLeftSeconds then return left.auctionID < right.auctionID end
    return (left.timeLeftSeconds or math.huge) < (right.timeLeftSeconds or math.huge)
  end)
  ownedLoaded = true
  return owned
end

-- An owned auction that vanished without an expiry event was almost
-- certainly sold. The client exposes no sale event outside the mailbox, so
-- this is recorded as an inferred sale at the posted price and labelled.
local function reconcile()
  if not ownedSynced or not ownedLoaded then return 0 end
  local ledger = WAH.Ledger and WAH.Ledger.current()
  if not ledger then return 0 end
  local present = {}
  for _, row in ipairs(owned) do present[row.auctionID] = true end
  local candidates = {}
  local nowTs = time()
  for auctionID, post in pairs(ledger.openPosts or {}) do
    if not present[auctionID] and not cancelling[auctionID]
      and post.at and nowTs - post.at >= 60 then
      candidates[#candidates + 1] = { auctionID = auctionID, post = post }
    end
  end
  table.sort(candidates, function(left, right) return left.auctionID < right.auctionID end)
  for _, candidate in ipairs(candidates) do
    local post = candidate.post
    local fee = math.floor((post.price or 0) * (post.qty or 0) * (WAH.RULES.feeRate or 0.05) + 0.5)
    WAH.recordEvent({
      k = "sold",
      auctionID = candidate.auctionID,
      itemId = post.itemId,
      qty = post.qty,
      price = post.price,
      fee = fee,
      inferred = true
    })
  end
  if #candidates > 0 then
    chatMessage(string.format(L.SELL_INFERRED_SOLD, #candidates))
  end
  return #candidates
end

local function cancelAuction(auctionID)
  if C_AuctionHouse.CanCancelAuction and not C_AuctionHouse.CanCancelAuction(auctionID) then
    return false, "cannotCancel"
  end
  local cost = C_AuctionHouse.GetCancelCost and C_AuctionHouse.GetCancelCost(auctionID) or 0
  local ledger = WAH.Ledger and WAH.Ledger.current()
  local post = ledger and ledger.openPosts and ledger.openPosts[auctionID]
  local deposit = post and post.deposit or 0
  cancelling[auctionID] = true
  local ok, err = pcall(C_AuctionHouse.CancelAuction, auctionID)
  if not ok then
    cancelling[auctionID] = nil
    return false, err
  end
  if WAH.Actions then
    WAH.Actions.cancel(auctionID, {
      refund = math.max(0, deposit - cost),
      lostDeposit = cost
    })
  else
    WAH.recordEvent({
      k = "cancel",
      auctionID = auctionID,
      refund = math.max(0, deposit - cost),
      lostDeposit = cost
    })
  end
  cancelling[auctionID] = nil
  chatMessage(string.format(L.SELL_CANCELLED, auctionID))
  if sell and sell:IsShown() then C_Timer.After(1, function() WAH.Sell.refreshOwned() end) end
  return true
end

local function refreshOwned()
  if not (C_AuctionHouse.QueryOwnedAuctions) then return end
  ownedLoaded = false
  pcall(C_AuctionHouse.QueryOwnedAuctions, {
    { sortOrder = Enum.AuctionHouseSortOrder.Price, reverseSort = false }
  })
end

-- ============================== Frame ===============================

local function ensureFrame()
  if sell then return sell end
  sell = CreateFrame("Frame", "WoWderhoiAHSell", UIParent, "BackdropTemplate")
  sell:SetSize(PANEL_WIDTH, PANEL_HEIGHT)
  sell:SetClampedToScreen(true)
  sell:SetMovable(true)
  local tradePage = WAH.tradeFrame and WAH.tradeFrame()
  local auctionHouse = WAH.ahFrame and WAH.ahFrame()
  if tradePage then
    sell:SetPoint("TOPLEFT", tradePage, "TOPLEFT", -PANEL_WIDTH - 4, 0)
  elseif auctionHouse then
    sell:SetPoint("TOPRIGHT", auctionHouse, "TOPLEFT", -4, 0)
  else
    sell:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
  end
  sell:SetBackdrop({
    bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
    edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile = true, tileSize = 32, edgeSize = 20,
    insets = { left = 5, right = 5, top = 5, bottom = 5 }
  })

  sell.title = sell:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  sell.title:SetPoint("TOPLEFT", PAD, -PAD)
  sell.title:SetText(L.SELL_TITLE)

  local close = CreateFrame("Button", nil, sell, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -PAD, -PAD)
  close:SetScript("OnClick", function() sell:Hide() end)

  sell.status = sell:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  sell.status:SetPoint("TOPLEFT", PAD, -26)
  sell.status:SetPoint("TOPRIGHT", -PAD - 44, -26)
  sell.status:SetJustifyH("LEFT")

  local function tabButton(label, anchor, onClick)
    local button = CreateFrame("Button", nil, sell, "UIPanelButtonTemplate")
    button:SetSize(70, 20)
    if anchor then
      button:SetPoint("LEFT", anchor, "RIGHT", 6, 0)
    else
      button:SetPoint("TOPLEFT", PAD, -44)
    end
    button:SetText(label)
    button:SetScript("OnClick", onClick)
    return button
  end

  sell.sellTab = tabButton(L.SELL_TAB, nil, function() WAH.Sell.setMode("sell") end)
  sell.ownedTab = tabButton(L.OWNED_TAB, sell.sellTab, function() WAH.Sell.setMode("owned") end)
  tabButton(L.SELL_REFRESH, sell.ownedTab, function() WAH.Sell.refresh() end)

  -- Bag list.
  sell.bagScroll = CreateFrame("ScrollFrame", "WoWderhoiAHSellBag", sell, "FauxScrollFrameTemplate")
  sell.bagScroll:SetPoint("TOPLEFT", PAD, -70)
  sell.bagScroll:SetPoint("TOPRIGHT", -28, -70)
  sell.bagScroll:SetHeight(BAG_ROWS * ROW_HEIGHT)
  sell.bagScroll:SetScript("OnVerticalScroll", function(self, delta)
    FauxScrollFrame_OnVerticalScroll(self, delta, ROW_HEIGHT, function() WAH.Sell.render() end)
  end)
  sell.bagRows = {}
  for index = 1, BAG_ROWS do
    local row = CreateFrame("Frame", nil, sell)
    row:SetHeight(ROW_HEIGHT)
    row:SetPoint("TOPLEFT", PAD, -70 - (index - 1) * ROW_HEIGHT)
    row:SetPoint("TOPRIGHT", -28, -70 - (index - 1) * ROW_HEIGHT)
    row.icon = row:CreateTexture(nil, "ARTWORK")
    row.icon:SetSize(16, 16)
    row.icon:SetPoint("LEFT", 0, 0)
    row.name = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    row.name:SetPoint("LEFT", row.icon, "RIGHT", 6, 0)
    row.name:SetPoint("RIGHT", row, "RIGHT", -70, 0)
    row.name:SetJustifyH("LEFT")
    row.select = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
    row.select:SetSize(62, 18)
    row.select:SetPoint("RIGHT", 0, 0)
    row.select:SetText(L.SELL_SELECT)
    row:EnableMouse(true)
    row:SetScript("OnMouseDown", function() WAH.Sell.select(row.itemId) end)
    row:Hide()
    sell.bagRows[index] = row
  end

  -- Detail block.
  sell.detail = sell:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  sell.detail:SetPoint("TOPLEFT", PAD, -70 - BAG_ROWS * ROW_HEIGHT - 8)
  sell.detail:SetPoint("TOPRIGHT", -PAD, -70 - BAG_ROWS * ROW_HEIGHT - 8)
  sell.detail:SetJustifyH("LEFT")

  sell.qtyBox = CreateFrame("EditBox", "WoWderhoiAHSellQty", sell, "InputBoxTemplate")
  sell.qtyBox:SetSize(60, 20)
  sell.qtyBox:SetPoint("TOPLEFT", PAD, -70 - BAG_ROWS * ROW_HEIGHT - 100)
  sell.qtyBox:SetAutoFocus(false)
  sell.qtyBox:SetNumeric(true)
  sell.qtyBox:SetScript("OnEnterPressed", function() WAH.Sell.render() end)

  sell.durationButtons = {}
  local anchor = sell.qtyBox
  for index, duration in ipairs(DURATIONS) do
    local button = CreateFrame("Button", nil, sell, "UIPanelButtonTemplate")
    button:SetSize(42, 20)
    button:SetPoint("LEFT", anchor, "RIGHT", 6, 0)
    button:SetText(string.format(L.SELL_HOURS, duration))
    button:SetScript("OnClick", function()
      selectedDuration = duration
      WAH.Sell.render()
    end)
    sell.durationButtons[index] = button
    anchor = button
  end

  sell.postButton = CreateFrame("Button", nil, sell, "UIPanelButtonTemplate")
  sell.postButton:SetSize(96, 22)
  sell.postButton:SetPoint("LEFT", anchor, "RIGHT", 10, 0)
  sell.postButton:SetText(L.SELL_POST)
  sell.postButton:SetScript("OnClick", function() WAH.Sell.postSelected() end)

  -- Owned list.
  sell.ownedScroll = CreateFrame("ScrollFrame", "WoWderhoiAHSellOwned", sell, "FauxScrollFrameTemplate")
  sell.ownedScroll:SetPoint("TOPLEFT", PAD, -70)
  sell.ownedScroll:SetPoint("BOTTOMRIGHT", -28, PAD)
  sell.ownedScroll:SetScript("OnVerticalScroll", function(self, delta)
    FauxScrollFrame_OnVerticalScroll(self, delta, ROW_HEIGHT, function() WAH.Sell.render() end)
  end)
  sell.ownedRows = {}
  for index = 1, OWNED_ROWS do
    local row = CreateFrame("Frame", nil, sell)
    row:SetHeight(ROW_HEIGHT)
    row:SetPoint("TOPLEFT", PAD, -70 - (index - 1) * ROW_HEIGHT)
    row:SetPoint("TOPRIGHT", -28, -70 - (index - 1) * ROW_HEIGHT)
    row.name = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    row.name:SetPoint("LEFT", 0, 0)
    row.name:SetPoint("RIGHT", row, "RIGHT", -170, 0)
    row.name:SetJustifyH("LEFT")
    row.price = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    row.price:SetPoint("RIGHT", row, "RIGHT", -80, 0)
    row.price:SetWidth(80)
    row.price:SetJustifyH("RIGHT")
    row.cancel = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
    row.cancel:SetSize(70, 18)
    row.cancel:SetPoint("RIGHT", 0, 0)
    row.cancel:SetText(L.SELL_CANCEL)
    row:Hide()
    sell.ownedRows[index] = row
  end

  sell:Hide()
  return sell
end

-- ============================== Render ==============================

local function render()
  if not sell then return end
  -- Same source as the decision core: the purse is what GetMoney reports
  -- now, not a snapshot taken at the last journal rebuild.
  sell.status:SetText(string.format(L.SELL_STATUS_FMT,
    #bagItems, #owned, coinString(GetMoney and GetMoney() or 0)))

  if mode == "sell" then
    sell.bagScroll:Show()
    sell.detail:Show()
    sell.qtyBox:Show()
    for _, button in ipairs(sell.durationButtons) do button:Show() end
    sell.postButton:Show()
    sell.ownedScroll:Hide()
    for _, row in ipairs(sell.ownedRows) do row:Hide() end

    local offset = FauxScrollFrame_GetOffset(sell.bagScroll)
    FauxScrollFrame_Update(sell.bagScroll, #bagItems, BAG_ROWS, ROW_HEIGHT)
    for index = 1, BAG_ROWS do
      local row = sell.bagRows[index]
      local entry = bagItems[index + offset]
      if entry then
        row.itemId = entry.itemId
        row.icon:SetTexture(entry.icon)
        row.name:SetText(string.format("%s x%d", entry.name, entry.count))
        row.select:SetScript("OnClick", function() WAH.Sell.select(entry.itemId) end)
        row:Show()
      else
        row:Hide()
      end
    end

    if not selected then
      sell.detail:SetText(L.SELL_EMPTY_BAG)
      return
    end
    local quantity = math.max(1, math.floor(tonumber(sell.qtyBox:GetText()) or selected.count or 1))
    local plan = planFor(selected.itemId, selectedDuration, quantity)
    if not plan then
      sell.detail:SetText(string.format(L.SELL_NO_DATA, selected.name))
      return
    end
    local lines = {
      string.format("%s |cff888888x%d|r", selected.name, selected.count),
      string.format("%s: %s", L.SELL_PRICE, coinString(plan.sellP)),
      string.format("%s: |cffff9933%s|r", L.SELL_LIST, coinString(plan.listP)),
      string.format("%s: %s", L.SELL_DEPOSIT, plan.depositAvailable and coinString(plan.deposit) or L.SELL_DEPOSIT_UNAVAILABLE),
      string.format("%s: %s", L.SELL_NET, coinString(plan.netIfSold)),
      string.format("%s: %s  |  %s: %s", L.SELL_BREAKEVEN, coinString(plan.sellBreakeven),
        L.SELL_EXPIRE_BREAKEVEN, coinString(plan.expireBreakeven)),
      string.format("%s: %s", L.SELL_LOSS, coinString(plan.lossIfExpired))
    }
    if plan.optimized then
      table.insert(lines, 3, string.format(L.SELL_RECOMMEND, coinString(plan.listP),
        plan.duration or 24, math.floor((plan.fillProb or 0) * 100 + 0.5)))
    end
    sell.detail:SetText(table.concat(lines, "\n"))
  else
    sell.bagScroll:Hide()
    sell.detail:Hide()
    sell.qtyBox:Hide()
    for _, button in ipairs(sell.durationButtons) do button:Hide() end
    sell.postButton:Hide()
    sell.ownedScroll:Show()
    for _, row in ipairs(sell.bagRows) do row:Hide() end

    local offset = FauxScrollFrame_GetOffset(sell.ownedScroll)
    FauxScrollFrame_Update(sell.ownedScroll, #owned, OWNED_ROWS, ROW_HEIGHT)
    for index = 1, OWNED_ROWS do
      local row = sell.ownedRows[index]
      local auction = owned[index + offset]
      if auction then
        local tag = auction.undercut and (" |cffff5555[" .. L.SELL_UNDERCUT .. "]|r") or ""
        row.name:SetText(string.format("%s x%d%s", auction.name, auction.quantity, tag))
        row.price:SetText(coinString(auction.unitPrice))
        row.cancel:SetScript("OnClick", function() WAH.Sell.cancel(auction.auctionID) end)
        row:Show()
      else
        row:Hide()
      end
    end
    if #owned == 0 then
      sell.status:SetText(L.SELL_OWNED_EMPTY)
    end
  end
end

-- ============================== Public API ===========================

local Sell = {}
Sell.collectBag = collectBag
Sell.collectOwned = collectOwned
Sell.render = render

function Sell.plan(itemId, duration, quantity)
  local plan = planFor(itemId, duration, quantity)
  return plan
end

function Sell.select(itemId)
  for _, entry in ipairs(bagItems) do
    if entry.itemId == itemId then
      selected = entry
      if sell and sell.qtyBox then sell.qtyBox:SetText(tostring(entry.count)) end
      render()
      return true
    end
  end
  return false
end

function Sell.postSelected()
  if not selected then return false, "noSelection" end
  local quantity = sell and tonumber(sell.qtyBox:GetText()) or selected.count
  return postItem(selected.itemId, selectedDuration, quantity or selected.count)
end

function Sell.cancel(auctionID)
  return cancelAuction(auctionID)
end

function Sell.refreshOwned()
  refreshOwned()
end

function Sell.refresh()
  collectBag()
  -- Always ask the client for a fresh owned list; the response event is the
  -- only place that may reconcile, because only then is the list complete.
  refreshOwned()
  render()
end

function Sell.setMode(nextMode)
  mode = nextMode
  if sell then
    sell.sellTab:SetText(mode == "sell" and ("|cffffd100" .. L.SELL_TAB .. "|r") or L.SELL_TAB)
    sell.ownedTab:SetText(mode == "owned" and ("|cffffd100" .. L.OWNED_TAB .. "|r") or L.OWNED_TAB)
  end
  refreshOwned()
  render()
end

function Sell.state()
  return {
    mode = mode,
    bag = bagItems,
    selected = selected,
    owned = owned,
    ownedLoaded = ownedLoaded,
    duration = selectedDuration,
    lastError = lastError
  }
end

function WAH.openSell()
  ensureFrame()
  collectBag()
  Sell.setMode("sell")
  sell:Show()
end

WAH.Sell = Sell

-- ============================== Events ==============================

local events = CreateFrame("Frame")
events:RegisterEvent("AUCTION_HOUSE_SHOW")
events:RegisterEvent("AUCTION_HOUSE_CLOSED")
events:RegisterEvent("AUCTION_HOUSE_AUCTION_CREATED")
events:RegisterEvent("AUCTION_HOUSE_AUCTIONS_EXPIRED")
events:RegisterEvent("OWNED_AUCTIONS_UPDATED")
events:RegisterEvent("ADDON_ACTION_BLOCKED")
events:RegisterEvent("ADDON_ACTION_FORBIDDEN")

events:SetScript("OnEvent", function(_, event, ...)
  if event == "AUCTION_HOUSE_SHOW" then
    if sell and sell:IsShown() then Sell.refresh() end
    return
  end
  if event == "AUCTION_HOUSE_CLOSED" then
    if sell then sell:Hide() end
    pendingPost = nil
    -- The owned list belonged to the session that just closed; the next
    -- page view must wait for a fresh query before reconciling again.
    ownedSynced = false
    ownedLoaded = false
    return
  end
  if event == "AUCTION_HOUSE_AUCTION_CREATED" then
    onAuctionCreated(...)
    return
  end
  if event == "AUCTION_HOUSE_AUCTIONS_EXPIRED" then
    onAuctionExpired(...)
    return
  end
  if event == "OWNED_AUCTIONS_UPDATED" then
    -- The client has now answered a QueryOwnedAuctions: this list is the
    -- whole account's current postings, so reconcile may treat gaps as sales.
    ownedSynced = true
    collectOwned()
    reconcile()
    if sell and sell:IsShown() then render() end
    return
  end
  if event == "ADDON_ACTION_BLOCKED" or event == "ADDON_ACTION_FORBIDDEN" then
    local addonName, functionName = ...
    if addonName == ADDON_NAME then
      chatMessage(string.format(L.SELL_BLOCKED, tostring(functionName)))
      pendingPost = nil
    end
  end
end)

SLASH_WOWDERHOIAHSELL1 = "/wahsell"
SlashCmdList["WOWDERHOIAHSELL"] = function() WAH.openSell() end
