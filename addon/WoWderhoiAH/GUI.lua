-- In-game price intelligence: the trader tooltip section, the order-book
-- and time-series chart, and the diagnostic command.
--
-- The anchor is the sell front, not a P10 median. The tooltip shows what
-- to list at first, then the book and supply behind it, and keeps P10 in a
-- statistics line. The chart defaults to the order book -- the one picture
-- that still means something before two scans exist -- and switches to a
-- time series with explicit windows when history is available.

local ADDON_NAME, WAH = ...
local L = WAH.L
local coinString = WAH.coinString
local getItemInfo = WAH.getItemInfo

local HOUR = 60 * 60
local DAY = 24 * HOUR

local function historyFor(itemId, windowHours)
  return WAH.history and WAH.history(itemId, windowHours)
end

local function currentItem(itemId)
  local scan = WAH.currentScan()
  return scan and scan.items and scan.items[itemId]
end

-- One count for every surface that reports how many items have history:
-- the login line, /wah, /wahtip and /wahdiag must not disagree.
local function historyItemCount()
  local market = WAH.seriesMarket and WAH.seriesMarket()
  if not market then return 0 end
  local count = 0
  for _ in pairs(market.items or {}) do count = count + 1 end
  return count
end

local function phaseLabel(phase)
  return (L.PHASE_LABELS and L.PHASE_LABELS[phase]) or phase or "?"
end

local function trendText(latest, reference, windowHours)
  if not reference or reference <= 0 then return "" end
  local delta = (latest - reference) / reference * 100
  local color = delta > 3 and "|cffff5555" or (delta < -3 and "|cff55ff55" or "|cffcccccc")
  return string.format(color .. L.TT_TREND_VS .. "|r", delta, windowHours)
end

local function rangeText(entry)
  if not entry or not entry.minSell or entry.maxSell == entry.minSell then return nil end
  local percentile = entry.latest and entry.maxSell > entry.minSell
    and (entry.latest - entry.minSell) / (entry.maxSell - entry.minSell) * 100 or 50
  return string.format(L.TT_RANGE_NOW,
    coinString(entry.minSell), coinString(entry.maxSell), percentile)
end

local function ladderText(entry)
  if not entry.tiers or #entry.tiers == 0 then return nil end
  local parts = {}
  for index = 1, math.min(3, #entry.tiers) do
    local tier = entry.tiers[index]
    parts[#parts + 1] = string.format("%s(%d)", coinString(tier.p), tier.q)
  end
  return table.concat(parts, " |cff666666/|r ")
end

-- Trader tooltip section: everywhere an item tooltip renders -- bags, bank,
-- equipped slots, merchants, the auction house, mail and chat item links.
-- Spell, unit and battle-pet links never carry it: the link gate rejects
-- anything that is not itself an item, so a shared tooltip cannot carry the
-- last item's panel onto a talent or character button.
--
-- The 1.60 client is a mixed pipeline: it exposes TooltipDataProcessor and
-- TooltipUtil, yet a native tooltip can be rendered by a setter without ever
-- reaching that processor. Presence of the modern API is therefore not
-- evidence that it fires, and subscribing to only one pipeline is how the
-- section disappeared from bag hovers. Every path is registered: the typed
-- post-call, ProcessInfo, OnTooltipSetItem and the item setters. The link
-- is read from the call's own arguments first -- the setter that named the
-- item -- then from TooltipUtil, GetItem and finally the rendered first
-- line.
--
-- Hover is read-only. The chart is a panel that lives beside the auction
-- house or the trader page, where its mode and window buttons stay put and
-- can be clicked; it never floats after a tooltip.
local observedItemId = nil
local chart = nil

local function hideChart()
  if chart then chart:Hide() end
end

-- Restricted tooltip data is secret on this client; reading it through a
-- pattern or a comparison raises. A secret value is unreadable, never an
-- item match.
local function isSecret(value)
  return issecretvalue ~= nil and issecretvalue(value)
end

local function readableString(value)
  return type(value) == "string" and not isSecret(value)
end

local function containerItemLink(bag, slot)
  if C_Container and C_Container.GetContainerItemLink then
    return C_Container.GetContainerItemLink(bag, slot)
  end
  if GetContainerItemLink then return GetContainerItemLink(bag, slot) end
  return nil
end

-- The typed tooltip data names the getter that produced the lines. Reading
-- the link from that getter's arguments is authoritative on a native
-- tooltip even when TooltipUtil has nothing to say about it.
local function getterItemLink(info)
  if type(info) ~= "table" or isSecret(info) then return nil end
  local getter, args = info.getterName, info.getterArgs
  if not readableString(getter) or type(args) ~= "table" then return nil end
  local arg1 = args[1]
  if getter == "GetHyperlink" then return arg1 end
  if getter == "GetBagItem" then return containerItemLink(arg1, args[2]) end
  if getter == "GetInventoryItem" then
    return GetInventoryItemLink and GetInventoryItemLink(arg1, args[2])
  end
  if getter == "GetMerchantItem" then
    return GetMerchantItemLink and GetMerchantItemLink(arg1)
  end
  if getter == "GetGuildBankItem" then
    return GetGuildBankItemLink and GetGuildBankItemLink(arg1, args[2])
  end
  if getter == "GetAuctionItem" then
    return GetAuctionItemLink and GetAuctionItemLink(arg1, args[2])
  end
  if (getter == "GetItemKey" or getter == "GetItemByID") and not isSecret(arg1) then
    return C_Item and C_Item.GetItemInfo and select(2, C_Item.GetItemInfo(arg1))
  end
  return nil
end

-- The rendered first line still carries the root hyperlink on native
-- tooltips: the pre-TooltipUtil accessor, and the last resort for a frame
-- that reports neither typed data nor a remembered item.
local function lineItemLink(tooltip)
  local name = tooltip.GetName and tooltip:GetName()
  if type(name) ~= "string" then return nil end
  local line = _G[name .. "TextLeft1"]
  local text = line and line.GetText and line:GetText()
  if not readableString(text) then return nil end
  return text:match("|H(item:[%d:%-]+)|h")
end

-- The section is identified by its own header line, not by a boolean. A
-- client re-render can wipe appended lines, and a stale boolean would then
-- hide the section for the rest of the session. Appending and detecting
-- the block share the title, and detection ignores the color codes so it
-- does not depend on how the client stores them.
local SECTION_TITLE = "WoWderhoi AHelper"
local SECTION_HEADER = "|cff33ff99" .. SECTION_TITLE .. "|r"

local function traderSectionAlive(tooltip)
  local name = tooltip.GetName and tooltip:GetName()
  if type(name) ~= "string" then return true end
  -- Frames without readable line globals cannot prove a wipe; trust the
  -- mark instead of appending the section again on every repost.
  local first = _G[name .. "TextLeft1"]
  if not first then return true end
  local count = tooltip.NumLines and tooltip:NumLines() or 0
  for index = 1, count do
    local line = _G[name .. "TextLeft" .. index]
    local text = line and line.GetText and line:GetText()
    if readableString(text) and text:find(SECTION_TITLE, 1, true) then
      return true
    end
  end
  return false
end

local function frameName(tooltip)
  local name = tooltip.GetName and tooltip:GetName()
  return type(name) == "string" and name or "?"
end

local function clearTraderMark(tooltip)
  tooltip.wahSectionLink = nil
end

-- The mark belongs to the frame that carries the lines. Clear it through
-- that frame's own scripts; some tooltip frames ship without
-- OnTooltipCleared, so ask before hooking instead of masking the error.
local function trackTooltip(tooltip)
  if tooltip.wahTracked then return end
  tooltip.wahTracked = true
  if tooltip.HasScript and tooltip:HasScript("OnTooltipCleared") then
    tooltip:HookScript("OnTooltipCleared", clearTraderMark)
  end
  tooltip:HookScript("OnHide", clearTraderMark)
end

-- Which entry point fired, and what it resolved. The 1.60 client uses more
-- than one tooltip pipeline, so a missing block needs to name the path that
-- missed. Records stay in memory and /wahtip prints them; a failed hover is
-- also reported to chat at most three times per session, because script
-- errors are commonly disabled.
local tipEvents = {}
local tipReported = 0
local hookFailures = {}

local function recordTip(text)
  tipEvents[#tipEvents + 1] = text
  if #tipEvents > 8 then table.remove(tipEvents, 1) end
end

local function reportTip(text)
  recordTip(text)
  if tipReported >= 3 then return end
  tipReported = tipReported + 1
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoWderhoiAH|r tip: " .. text)
end

local function noteHookFailure(label, err)
  local text = string.format("hook %s failed: %s", label,
    isSecret(err) and "secret value" or tostring(err))
  hookFailures[#hookFailures + 1] = text
  reportTip(text)
end

-- A registration that raises must cost exactly that one entry point. The
-- rest of the file -- including /wahtip -- has to keep working, or a client
-- quirk turns into a silent load abort with no way to diagnose it.
local function installMethodHook(label, frame, method, handler)
  if not (frame and frame[method]) then return false end
  local ok, err = pcall(hooksecurefunc, frame, method, handler)
  if not ok then noteHookFailure(label .. "/" .. method, err) end
  return ok
end

local function installScriptHook(label, frame, script, handler)
  if not (frame and frame.HookScript) then return false end
  if frame.HasScript and not frame:HasScript(script) then return false end
  local ok, err = pcall(frame.HookScript, frame, script, handler)
  if not ok then noteHookFailure(label .. "/" .. script, err) end
  return ok
end

local function pipelineFacts()
  local postcall = TooltipDataProcessor ~= nil
    and type(TooltipDataProcessor.AddTooltipPostCall) == "function"
  return string.format(
    "loaded=GUI processor=%s postcall=%s util=%s primary=%s setItem=%s bag=%s hyperlink=%s",
    tostring(TooltipDataProcessor ~= nil),
    tostring(postcall),
    tostring(TooltipUtil ~= nil and type(TooltipUtil.GetDisplayedItem) == "function"),
    tostring(type(GameTooltip.GetPrimaryTooltipData) == "function"),
    tostring(GameTooltip.HasScript and GameTooltip:HasScript("OnTooltipSetItem")),
    tostring(GameTooltip.SetBagItem ~= nil),
    tostring(GameTooltip.SetHyperlink ~= nil))
end

-- Registered before any hook on purpose: a failed registration later in the
-- file must not take the diagnostic command with it.
SLASH_WOWDERHOIAHTIP1 = "/wahtip"
SlashCmdList["WOWDERHOIAHTIP"] = function()
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoWderhoiAH|r " .. pipelineFacts())
  local scan = WAH.currentScan and WAH.currentScan()
  DEFAULT_CHAT_FRAME:AddMessage(string.format(
    "|cff33ff99WoWderhoiAH|r data: hasScan=%s hasHistory=%d scanAge=%s",
    tostring(scan ~= nil), historyItemCount(),
    tostring(WAH.scanAgeMinutes and WAH.scanAgeMinutes() or "n/a")))
  if #hookFailures == 0 then
    DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoWderhoiAH|r hooks: all registered")
  else
    for _, failure in ipairs(hookFailures) do
      DEFAULT_CHAT_FRAME:AddMessage("|cffff5555WoWderhoiAH|r " .. failure)
    end
  end
  for _, event in ipairs(tipEvents) do
    DEFAULT_CHAT_FRAME:AddMessage("  " .. event)
  end
end

local function itemType()
  return Enum and Enum.TooltipDataType and Enum.TooltipDataType.Item
end

-- Item identity is resolved once, from the most authoritative source the
-- client offers. The typed TooltipData already carries the item ID; a
-- setter names it in its own arguments; TooltipUtil, GetItem and the
-- rendered first line are fallbacks for native frames that report nothing
-- typed. `sawLink` separates "this is a spell link" from "no link at all":
-- only the second is a pipeline failure worth reporting.
local function resolveItem(tooltip, hyperlink, explicit, data)
  if type(data) == "table" and not isSecret(data) then
    local dataType = data.type
    if isSecret(dataType) then dataType = nil end
    local id = data.id
    if dataType ~= nil and dataType == itemType()
      and type(id) == "number" and not isSecret(id) then
      return id, "data.id", true
    end
    local typedLink = data.hyperlink
    if readableString(typedLink) then
      return WAH.itemIdFromLink(typedLink), "data.link", true
    end
  end
  if readableString(hyperlink) then
    return WAH.itemIdFromLink(hyperlink), "setter", true
  end
  if explicit then
    -- The call named its slot but produced no link: an empty slot, never
    -- permission to reuse the item the shared tooltip still remembers.
    return nil, "empty", false
  end
  local infoLink = getterItemLink(tooltip.processingInfo or tooltip.info)
  if readableString(infoLink) then
    return WAH.itemIdFromLink(infoLink), "getter", true
  end
  if TooltipUtil and TooltipUtil.GetDisplayedItem then
    local _, link, id = TooltipUtil.GetDisplayedItem(tooltip)
    if type(id) == "number" and not isSecret(id) then
      return id, "util.id", true
    end
    if readableString(link) then
      return WAH.itemIdFromLink(link), "util.link", true
    end
  end
  if tooltip.GetItem then
    local _, remembered = tooltip:GetItem()
    if readableString(remembered) then
      return WAH.itemIdFromLink(remembered), "getitem", true
    end
  end
  local lineLink = lineItemLink(tooltip)
  if readableString(lineLink) then
    return WAH.itemIdFromLink(lineLink), "line", true
  end
  return nil, "none", false
end

-- The observer hands the item to the chart before any display switch is
-- consulted. `tooltip` and `chart` are independent consumers of the same
-- observation; neither can short-circuit the other.
local function observeItem(itemId)
  if observedItemId == itemId then return end
  -- The refresh entry owns the selection write, so the observed item has
  -- exactly one writer even when the chart is switched off or has no host.
  if WoWderhoiAH_UpdateChart then WoWderhoiAH_UpdateChart(itemId) end
end

local function renderTraderSection(tooltip, itemId, source, resolvedFrom)
  -- Another entry point reposted the same item and the rendered lines still
  -- carry the section: nothing to add. A wipe drops the header line, and
  -- the scan below then lets the section back in.
  if tooltip.wahSectionLink == itemId and traderSectionAlive(tooltip) then return end
  local scanned = currentItem(itemId)
  -- Inspect the raw global on purpose: this is the one place that must tell
  -- "no scan yet" apart from "a scan from another pipeline is on disk".
  local raw = WoWderhoiAH_ScanData
  local staleScan = not scanned and type(raw) == "table"
    and raw.dataVersion ~= WAH.PIPELINE_VERSION and raw.items ~= nil
  local entry = historyFor(itemId)
  if not scanned and not entry and not staleScan then
    recordTip(string.format("%s/%s: item=%d has no scan or history",
      source, resolvedFrom, itemId))
    return
  end
  trackTooltip(tooltip)
  tooltip:AddLine(" ")
  tooltip:AddLine(SECTION_HEADER)
  if staleScan then
    tooltip:AddLine("|cffff8800" .. L.TT_SCAN_STALE .. "|r")
  end
  local phase = WAH.currentPhase and WAH.currentPhase() or "steady"
  if scanned then
    local age = math.floor(WAH.scanAgeMinutes() or 0)
    -- Same compiled threshold as the terminal banner: one scan, one verdict.
    local stale = age >= WAH.RULES.scanStaleMinutes
    tooltip:AddDoubleLine(string.format(L.TT_SCAN_HEADER, age) .. " |cff888888" .. phaseLabel(phase) .. "|r", "")
    -- Sell front leads every other price: it is the action anchor.
    if scanned.sellP then
      tooltip:AddDoubleLine("  |cffff9933" .. L.TT_SELLP .. "|r", coinString(scanned.sellP))
    end
    tooltip:AddDoubleLine("  " .. L.TT_MIN, coinString(scanned.minPrice))
    local ladder = ladderText(scanned)
    if ladder then tooltip:AddDoubleLine("  " .. L.TT_LADDER, ladder) end
    tooltip:AddDoubleLine("  " .. L.TT_SUPPLY, string.format(L.TT_SUPPLY_FMT,
      scanned.quantity or 0, scanned.numAuctions or 0, scanned.sellers or 0))
    if scanned.inferredSoldHigh and scanned.inferredSoldHigh > 0 then
      tooltip:AddDoubleLine("  " .. L.TT_INFERRED,
        string.format(L.TT_INFERRED_FMT, scanned.inferredSoldLow or 0, scanned.inferredSoldHigh))
    end
    -- P10 is a statistic, never a decision anchor.
    tooltip:AddDoubleLine("  |cff888888" .. L.TT_P10_STAT .. "|r", coinString(scanned.marketPrice or 0))
    if stale then tooltip:AddLine("|cffff8800" .. L.TT_SCAN_STALE .. "|r") end
  end
  if entry then
    if scanned then tooltip:AddLine(" ") end
    local window = entry.windowHours
    tooltip:AddDoubleLine(string.format(L.TT_HISTORY_HEADER, window), "")
    tooltip:AddDoubleLine("  " .. L.TT_SELL_REF, coinString(entry.sellRef or 0))
    if scanned and scanned.sellP and entry.sellRef then
      local trend = trendText(scanned.sellP, entry.sellRef, window)
      if trend ~= "" then tooltip:AddDoubleLine("  " .. L.TT_TREND, trend) end
    end
    local range = rangeText(entry)
    if range then tooltip:AddDoubleLine("  " .. string.format(L.TT_RANGE, window), range) end
  end
  tooltip:AddLine(" ")
  -- Appending never decides whether the frame is visible. A shown tooltip
  -- is re-laid out so the new lines are not clipped; a hidden one is shown
  -- by the client's own setter pass.
  if tooltip:IsShown() then tooltip:Show() end
  tooltip.wahSectionLink = itemId
  recordTip(string.format("%s/%s: item=%d appended (frame=%s)",
    source, resolvedFrom, itemId, frameName(tooltip)))
end

-- One entry point for every pipeline. strict marks the paths that can only
-- fire for an item: a missing link there is a failure worth reporting.
-- ProcessInfo is generic and stays silent about non-item tooltips.
local function onTooltipEntry(source, tooltip, hyperlink, explicit, data, strict)
  if tooltip.IsForbidden and tooltip:IsForbidden() then return end
  local itemId, resolvedFrom, sawLink = resolveItem(tooltip, hyperlink, explicit, data)
  if not itemId then
    if resolvedFrom == "empty" then
      recordTip(string.format("%s: empty slot (frame=%s)", source, frameName(tooltip)))
    elseif strict and not sawLink then
      reportTip(string.format("%s: no item link (frame=%s)", source, frameName(tooltip)))
    end
    return
  end
  observeItem(itemId)
  if WAH.settings and not WAH.settings.tooltip then
    recordTip(string.format("%s/%s: item=%d observed (tooltip off)",
      source, resolvedFrom, itemId))
    return
  end
  renderTraderSection(tooltip, itemId, source, resolvedFrom)
end

-- Every entry point this client can use to render an item tooltip. The
-- setter's own arguments name the item authoritatively; when a setter has no
-- link API the append falls back to the frame's displayed item.
local SETTER_LINKS = {
  SetHyperlink = function(_, link) return link end,
  SetBagItem = function(_, bag, slot) return containerItemLink(bag, slot) end,
  SetInventoryItem = function(_, unit, slot)
    return GetInventoryItemLink and GetInventoryItemLink(unit, slot)
  end,
  SetMerchantItem = function(_, index)
    return GetMerchantItemLink and GetMerchantItemLink(index)
  end,
  SetAuctionItem = function(_, itemType, index)
    return GetAuctionItemLink and GetAuctionItemLink(itemType, index)
  end,
  SetAuctionSellItem = function() return nil end,
  SetGuildBankItem = function(_, tab, slot)
    return GetGuildBankItemLink and GetGuildBankItemLink(tab, slot)
  end,
  SetItemByGUID = function(_, guid)
    return C_Item and C_Item.GetItemLinkByGUID and C_Item.GetItemLinkByGUID(guid)
  end
}

-- Setters with no link accessor: the tooltip is still a valid item hover,
-- so these alone may fall back to the frame's displayed item.
local LINKLESS_SETTER = { SetAuctionSellItem = true }

local function runEntry(source, tooltip, hyperlink, explicit, data, strict)
  local ok, err = pcall(onTooltipEntry, source, tooltip, hyperlink, explicit, data, strict)
  if ok then return end
  reportTip(source .. ": error: " .. (isSecret(err) and "secret value" or tostring(err)))
end

local function hookTooltipFrame(frame)
  if not frame then return end
  installScriptHook("OnTooltipSetItem", frame, "OnTooltipSetItem", function(self)
    runEntry("OnTooltipSetItem", self, nil, false, nil, true)
  end)
  -- The tooltip data table carries its own hyperlink. This fires on the
  -- render call itself, so it still names the item when the post-call
  -- registration is present but does not fire on this client.
  installMethodHook("ProcessInfo", frame, "ProcessInfo", function(self, data)
    local link = type(data) == "table" and data.hyperlink
    runEntry("ProcessInfo", self, link, readableString(link), data, false)
  end)
  for method, linkFrom in pairs(SETTER_LINKS) do
    if frame[method] then
      local hookedMethod, resolve = method, linkFrom
      installMethodHook("setter", frame, hookedMethod, function(self, ...)
        runEntry(hookedMethod, self, resolve(self, ...),
          not LINKLESS_SETTER[hookedMethod], nil, true)
      end)
    end
  end
end

-- The processor registration is one path among several, never a substitute
-- for the others: on this client it can exist without firing for a native
-- setter-rendered tooltip.
local function registerPostCall()
  if not (TooltipDataProcessor and Enum and Enum.TooltipDataType
    and TooltipDataProcessor.AddTooltipPostCall) then return end
  local ok, err = pcall(TooltipDataProcessor.AddTooltipPostCall,
    Enum.TooltipDataType.Item, function(tooltip, data)
      runEntry("postcall", tooltip, nil, false, data, true)
    end)
  if not ok then noteHookFailure("postcall/AddTooltipPostCall", err) end
end
registerPostCall()

hookTooltipFrame(GameTooltip)
hookTooltipFrame(ItemRefTooltip)
if GameTooltipTooltip and GameTooltipTooltip ~= GameTooltip then
  hookTooltipFrame(GameTooltipTooltip)
end

-- ============================== Chart ===============================

local CHART_WIDTH, CHART_HEIGHT = 320, 320
local PLOT_LEFT = 14
local PLOT_WIDTH = CHART_WIDTH - 28
local PLOT_HEIGHT = 96
local PLOT_TOP = 94
local PLOT_BOTTOM = CHART_HEIGHT - PLOT_TOP - PLOT_HEIGHT

local WINDOWS = {
  { key = "1h", hours = 1, label = "CHART_WINDOW_1H" },
  { key = "6h", hours = 6, label = "CHART_WINDOW_6H" },
  { key = "24h", hours = 24, label = "CHART_WINDOW_24H" },
  { key = "7d", hours = 168, label = "CHART_WINDOW_7D" },
  { key = "all", hours = 0, label = "CHART_WINDOW_ALL" }
}

local chartMode = nil -- nil = automatic: book with <2 points, time otherwise
local chartWindow = nil -- nil = phase default

local function coinLabel(amount)
  if amount >= 100 * 10000 then
    amount = amount - amount % 10000
  elseif amount >= 10000 then
    amount = amount - amount % 100
  end
  return coinString(amount)
end

local function ensureLine(pool, index)
  local line = pool[index]
  if not line then
    line = chart:CreateLine(nil, "ARTWORK")
    line:SetThickness(2)
    pool[index] = line
  end
  return line
end

local function hideFrom(pool, index)
  for cursor = index, #pool do pool[cursor]:Hide() end
end

local function ensureBar(index)
  chart.bars = chart.bars or {}
  local bar = chart.bars[index]
  if not bar then
    bar = chart:CreateTexture(nil, "BACKGROUND")
    bar:SetColorTexture(0.2, 0.35, 0.55, 0.7)
    chart.bars[index] = bar
  end
  return bar
end

local function hideBarsFrom(index)
  chart.bars = chart.bars or {}
  for cursor = index, #chart.bars do chart.bars[cursor]:Hide() end
end

local function ensureDot(index)
  chart.dots = chart.dots or {}
  local dot = chart.dots[index]
  if not dot then
    dot = chart:CreateTexture(nil, "OVERLAY")
    dot:SetColorTexture(1, 0.6, 0.2, 1)
    dot:SetSize(5, 5)
    chart.dots[index] = dot
  end
  return dot
end

local function hideDotsFrom(index)
  chart.dots = chart.dots or {}
  for cursor = index, #chart.dots do chart.dots[cursor]:Hide() end
end

local function setState(state)
  chart._state = state
end

local function renderBook(entry)
  chart.segments = chart.segments or {}
  local tiers = entry.tiers or {}
  if #tiers == 0 then
    chart.hilo:SetText(L.CHART_NO_BOOK)
    chart.startLabel:SetText("")
    chart.endLabel:SetText("")
    hideFrom(chart.segments, 1)
    hideBarsFrom(1)
    hideDotsFrom(1)
    setState({ mode = "book", points = 0 })
    return
  end
  local total = 0
  for _, tier in ipairs(tiers) do total = total + tier.q end
  local minP, maxP = tiers[1].p, tiers[#tiers].p
  local span = math.max(maxP - minP, 1)
  local function xFor(price) return PLOT_LEFT + (price - minP) / span * PLOT_WIDTH end
  local function yFor(cumulative) return PLOT_BOTTOM + (total > 0 and cumulative / total or 0) * PLOT_HEIGHT end

  -- Step line: each price level holds its cumulative quantity until the
  -- next level. A vertical segment is what makes the book a staircase.
  local cursor, cumulative = 0, 0
  for tierIndex, tier in ipairs(tiers) do
    local previous = cumulative
    cumulative = cumulative + tier.q
    cursor = cursor + 1
    local line = ensureLine(chart.segments, cursor)
    line:SetStartPoint("BOTTOMLEFT", chart, xFor(tier.p), yFor(previous))
    line:SetEndPoint("BOTTOMLEFT", chart, xFor(tier.p), yFor(cumulative))
    line:SetColorTexture(0.55, 0.75, 1, 0.9)
    line:Show()
    local nextPrice = tiers[tierIndex + 1] and tiers[tierIndex + 1].p or tier.p
    if nextPrice > tier.p then
      cursor = cursor + 1
      local horizontal = ensureLine(chart.segments, cursor)
      horizontal:SetStartPoint("BOTTOMLEFT", chart, xFor(tier.p), yFor(cumulative))
      horizontal:SetEndPoint("BOTTOMLEFT", chart, xFor(nextPrice), yFor(cumulative))
      horizontal:SetColorTexture(0.55, 0.75, 1, 0.55)
      horizontal:Show()
    end
  end
  hideFrom(chart.segments, cursor + 1)
  hideBarsFrom(1)

  local dotCount = 1
  local minDot = ensureDot(dotCount)
  minDot:ClearAllPoints()
  minDot:SetPoint("CENTER", chart, "BOTTOMLEFT", xFor(minP), yFor(0))
  minDot:SetColorTexture(0.55, 0.75, 1, 1)
  minDot:Show()
  if entry.sellP and entry.sellP > 0 then
    dotCount = dotCount + 1
    local sellDot = ensureDot(dotCount)
    sellDot:ClearAllPoints()
    sellDot:SetPoint("CENTER", chart, "BOTTOMLEFT", xFor(entry.sellP), yFor(total))
    sellDot:SetColorTexture(1, 0.6, 0.2, 1)
    sellDot:Show()
  end
  hideDotsFrom(dotCount + 1)

  chart.hilo:SetText(string.format(L.CHART_BOOK_INFO,
    coinLabel(minP), coinLabel(entry.sellP or maxP), total))
  chart.startLabel:SetText(coinLabel(minP))
  chart.endLabel:SetText(coinLabel(maxP))
  setState({
    mode = "book",
    points = #tiers,
    sellP = entry.sellP,
    supply = total
  })
end

local function medianInterval(points)
  if #points < 3 then return nil end
  local gaps = {}
  for index = 2, #points do gaps[#gaps + 1] = points[index].t - points[index - 1].t end
  -- Local median spacing: an outage breaks the line at any fold level without
  -- the chart needing to know which retention layer produced each point. The
  -- terminal applies resolution-aware limits instead (chart-series.ts), so
  -- the two charts agree on raw scans and may break a folded gap differently.
  return WAH.Core.median(gaps)
end

local function renderTime(entry, windowHours)
  chart.segments = chart.segments or {}
  local now = time()
  local cutoff = windowHours > 0 and (now - windowHours * HOUR) or 0
  local points = {}
  for _, point in ipairs(entry.pts or {}) do
    if point.t >= cutoff then points[#points + 1] = point end
  end
  local minPrice, maxPrice = math.huge, 0
  local maxSupply = 0
  for _, point in ipairs(points) do
    local sell = point.sell
    local low = point.min or sell
    if sell < minPrice then minPrice = sell end
    if low < minPrice then minPrice = low end
    if sell > maxPrice then maxPrice = sell end
    if low > maxPrice then maxPrice = low end
    if (point.q or 0) > maxSupply then maxSupply = point.q or 0 end
  end
  -- Every empty case -- too few points, or points without a price -- wipes
  -- the previous item's picture. A panel that keeps the last item's lines
  -- and labels under a new title is worse than an empty plot. The state
  -- still records the item and point count for the subtitle.
  if #points < 2 or minPrice == math.huge or maxPrice == 0 then
    chart.hilo:SetText(L.CHART_EMPTY)
    chart.startLabel:SetText("")
    chart.endLabel:SetText("")
    hideFrom(chart.segments, 1)
    hideBarsFrom(1)
    hideDotsFrom(1)
    setState({ mode = "time", window = windowHours, points = #points })
    return
  end
  local logScale = minPrice > 0 and maxPrice / minPrice > 4
  local firstT, lastT = points[1].t, points[#points].t
  local timeSpan = math.max(lastT - firstT, 1)
  local function yFor(price)
    if maxPrice == minPrice then return PLOT_BOTTOM + PLOT_HEIGHT * 0.5 end
    if logScale then
      if price <= 0 or minPrice <= 0 then return PLOT_BOTTOM end
      return PLOT_BOTTOM + math.log(price / minPrice) / math.log(maxPrice / minPrice) * PLOT_HEIGHT
    end
    return PLOT_BOTTOM + (price - minPrice) / (maxPrice - minPrice) * PLOT_HEIGHT
  end
  local function xFor(stamp) return PLOT_LEFT + (stamp - firstT) / timeSpan * PLOT_WIDTH end
  local gapLimit = (medianInterval(points) or timeSpan) * 3

  local segmentCount = 0
  local function drawSeries(key, red, green, blue, alpha)
    for index = 1, #points - 1 do
      local left, right = points[index], points[index + 1]
      if right.t - left.t <= gapLimit then
        local leftValue, rightValue = left[key], right[key]
        if leftValue and rightValue then
          segmentCount = segmentCount + 1
          local line = ensureLine(chart.segments, segmentCount)
          line:SetStartPoint("BOTTOMLEFT", chart, xFor(left.t), yFor(leftValue))
          line:SetEndPoint("BOTTOMLEFT", chart, xFor(right.t), yFor(rightValue))
          line:SetColorTexture(red, green, blue, alpha)
          line:Show()
        end
      end
    end
  end
  drawSeries("sell", 1, 0.6, 0.2, 0.95)
  drawSeries("min", 0.6, 0.65, 0.75, 0.55)
  hideFrom(chart.segments, segmentCount + 1)

  local barCount = 0
  for index, point in ipairs(points) do
    if maxSupply > 0 and (point.q or 0) > 0 then
      barCount = barCount + 1
      local bar = ensureBar(barCount)
      local height = math.max(1, (point.q or 0) / maxSupply * 18)
      bar:ClearAllPoints()
      bar:SetSize(math.max(PLOT_WIDTH / #points - 1, 2), height)
      bar:SetPoint("BOTTOMLEFT", chart, xFor(point.t), PLOT_BOTTOM - 20)
      bar:Show()
    end
  end
  hideBarsFrom(barCount + 1)

  local dotCount = 0
  for _, point in ipairs(points) do
    if point.event == 1 then
      dotCount = dotCount + 1
      local dot = ensureDot(dotCount)
      dot:ClearAllPoints()
      dot:SetPoint("CENTER", chart, "BOTTOMLEFT", xFor(point.t), yFor(point.sell))
      dot:SetColorTexture(1, 0.8, 0.3, 1)
      dot:Show()
    end
  end
  hideDotsFrom(dotCount + 1)

  local labelFormat = timeSpan < DAY and "%H:%M" or "%m-%d %H:%M"
  chart.startLabel:SetText(date(labelFormat, firstT))
  chart.endLabel:SetText(date(labelFormat, lastT))
  chart.hilo:SetText(string.format(L.CHART_HILO, coinLabel(maxPrice), coinLabel(minPrice),
    logScale and L.CHART_LOG or ""))
  setState({
    mode = "time",
    window = windowHours,
    points = #points,
    logScale = logScale,
    segments = segmentCount
  })
end

local chartHosts = {}

-- Panels register themselves when they are created, not when the chart
-- first asks where to dock. The trader page is built inside the client's
-- AUCTION_HOUSE_SHOW dispatch, after this file's own handler has already
-- run; a lazy lookup would leave the chart on the auction house until the
-- next hover. Priority decides between hosts that are open together.
local function registerChartHost(frame, priority)
  if not frame or frame.wahChartHost then return end
  frame.wahChartHost = true
  chartHosts[#chartHosts + 1] = { frame = frame, priority = priority or 0 }
  frame:HookScript("OnShow", function() WoWderhoiAH_UpdateChart() end)
  frame:HookScript("OnHide", function() WoWderhoiAH_UpdateChart() end)
end
WAH.registerChartHost = registerChartHost

-- The chart has two possible homes, both persistent: the WAH trader page
-- when it is open, otherwise the auction house. With neither open there is
-- no chart -- a 320px panel with buttons has no business riding a tooltip
-- that disappears as soon as the pointer moves.
local function chartAnchor()
  local best, bestPriority = nil, nil
  for _, host in ipairs(chartHosts) do
    if host.frame:IsShown() and (bestPriority == nil or host.priority > bestPriority) then
      best, bestPriority = host.frame, host.priority
    end
  end
  return best
end

-- The auction house frame is a client global that may load after this file.
-- Register it when it exists; the SHOW handler retries for clients that
-- create it lazily.
local auctionHouseFrame = WAH.ahFrame()
if auctionHouseFrame then registerChartHost(auctionHouseFrame, 0) end

local function dockChart(anchor)
  chart:ClearAllPoints()
  -- The trader page is movable. When it sits at the right edge there is no
  -- room for a 320px panel beside it, so dock on its left instead of
  -- pushing the title and buttons off screen.
  local screenWidth = UIParent and UIParent.GetWidth and UIParent:GetWidth()
  local anchorRight = anchor.GetRight and anchor:GetRight()
  if screenWidth and anchorRight and anchorRight + 4 + CHART_WIDTH > screenWidth then
    chart:SetPoint("TOPRIGHT", anchor, "TOPLEFT", -4, -12)
  else
    chart:SetPoint("TOPLEFT", anchor, "TOPRIGHT", 4, -12)
  end
end

local function renderChart(itemId, anchor)
  local entry = currentItem(itemId)
  -- Read the whole retained series and let the selected window filter what
  -- is drawn. Fetching the phase window here made the 24h/7d/all buttons
  -- redraw the same handful of points in wave and settle.
  local window = chartWindow or WAH.phaseWindowHours()
  local history = historyFor(itemId, WAH.seriesRetentionHours())
  if not entry and not history then hideChart() return end
  dockChart(anchor)
  local name = getItemInfo(itemId) or ("item:" .. itemId)
  chart.title:SetText(name)

  local hasHistory = history and #(history.pts or {}) >= 2
  local mode = chartMode or (hasHistory and "time" or "book")
  if mode == "time" and not hasHistory then mode = "book" end
  if mode == "book" then
    renderBook(entry or { tiers = {} })
    chart.subtitle:SetText(string.format(L.CHART_SUBTITLE_BOOK,
      (entry and entry.numAuctions) or 0, phaseLabel(WAH.currentPhase and WAH.currentPhase() or "steady")))
  else
    renderTime(history, window)
    -- Report the points actually inside the selected window, not the size
    -- of the retained series.
    local shown = chart._state and chart._state.points or 0
    chart.subtitle:SetText(string.format(L.CHART_SUBTITLE,
      shown, coinString(history.latest or 0), window > 0 and window or L.CHART_WINDOW_ALL))
  end
  for _, button in ipairs(chart.modeButtons) do
    button:SetText(button.mode == mode and ("|cffffd100" .. button.label .. "|r") or button.label)
  end
  for _, button in ipairs(chart.windowButtons) do
    button:SetShown(mode == "time")
    button:SetText(button.hours == window and ("|cffffd100" .. button.label .. "|r") or button.label)
  end
  -- The state names the item it describes: the panel outlives the tooltip,
  -- and "which item is this" must not be inferred from the title text.
  chart._state.itemId = itemId
  chart:Show()
end

local function createChart()
  chart = CreateFrame("Frame", "WoWderhoiAHChart", UIParent, "BackdropTemplate")
  chart:SetSize(CHART_WIDTH, CHART_HEIGHT)
  chart:SetClampedToScreen(true)
  chart:SetFrameStrata("TOOLTIP")
  chart:SetBackdrop({
    bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
    edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile = true, tileSize = 32, edgeSize = 24,
    insets = { left = 6, right = 6, top = 6, bottom = 6 }
  })
  chart.title = chart:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  chart.title:SetPoint("TOPLEFT", 12, -10)
  chart.subtitle = chart:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  chart.subtitle:SetPoint("TOPLEFT", 12, -26)
  chart.hilo = chart:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  chart.hilo:SetPoint("TOPLEFT", PLOT_LEFT, -(PLOT_TOP + PLOT_HEIGHT + 6))
  chart.startLabel = chart:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  chart.startLabel:SetPoint("TOPLEFT", PLOT_LEFT, -(PLOT_TOP + PLOT_HEIGHT + 22))
  chart.endLabel = chart:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  chart.endLabel:SetPoint("TOPRIGHT", -PLOT_LEFT, -(PLOT_TOP + PLOT_HEIGHT + 22))

  local function tab(parent, anchor, label, width, onClick)
    local button = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
    button:SetSize(width or 52, 18)
    if anchor then
      button:SetPoint("LEFT", anchor, "RIGHT", 4, 0)
    else
      button:SetPoint("TOPLEFT", 12, -44)
    end
    button:SetText(label)
    button:SetScript("OnClick", onClick)
    return button
  end

  local bookButton = tab(chart, nil, L.CHART_BOOK, 52, function() WAH.setChartMode("book") end)
  bookButton.mode, bookButton.label = "book", L.CHART_BOOK
  local timeButton = tab(chart, bookButton, L.CHART_TIME, 52, function() WAH.setChartMode("time") end)
  timeButton.mode, timeButton.label = "time", L.CHART_TIME
  chart.modeButtons = { bookButton, timeButton }

  chart.windowButtons = {}
  local windowAnchor = nil
  for _, window in ipairs(WINDOWS) do
    local button = CreateFrame("Button", nil, chart, "UIPanelButtonTemplate")
    button:SetSize(40, 18)
    if windowAnchor then
      button:SetPoint("LEFT", windowAnchor, "RIGHT", 4, 0)
    else
      button:SetPoint("TOPLEFT", 12, -66)
    end
    button:SetText(L[window.label])
    button:SetScript("OnClick", function() WAH.setChartWindow(window.hours) end)
    button.hours = window.hours
    button.label = L[window.label]
    chart.windowButtons[#chart.windowButtons + 1] = button
    windowAnchor = button
  end

  chart.segments = {}
  chart.bars = {}
  chart.dots = {}
  chart:Hide()
end

-- The only refresh entry. Every trigger -- a hover, a panel showing, a
-- settings change, a scan finishing, a window button -- goes through here,
-- so the switch, the host and the selected item are judged in one place.
function WoWderhoiAH_UpdateChart(itemId)
  if itemId then observedItemId = itemId end
  if WAH.settings and not WAH.settings.chart then
    hideChart()
    return
  end
  local anchor = chartAnchor()
  if not observedItemId or not anchor then
    hideChart()
    return
  end
  if not chart then createChart() end
  renderChart(observedItemId, anchor)
end

function WAH.setChartMode(mode)
  chartMode = mode
  WoWderhoiAH_UpdateChart()
end

function WAH.setChartWindow(hours)
  chartWindow = hours
  chartMode = "time"
  WoWderhoiAH_UpdateChart()
end

-- The data layer publishes a finished scan; the chart redraws from the same
-- observation it already holds.
WAH.onScanFinished = function()
  WoWderhoiAH_UpdateChart()
end

-- A display switch takes effect in the click that wrote it. The phase and
-- the server anchor decide the default window, so they redraw too.
WAH.onSettingsChanged = function(key)
  if key == "chart" or key == "phaseOverride" or key == "serverOpenedAt" then
    WoWderhoiAH_UpdateChart()
  end
end

function WAH.chartState()
  return chart and chart._state or nil
end

-- ============================== Status ==============================

local guiFrame = CreateFrame("Frame")
guiFrame:RegisterEvent("PLAYER_LOGIN")
guiFrame:RegisterEvent("AUCTION_HOUSE_SHOW")
guiFrame:RegisterEvent("AUCTION_HOUSE_CLOSED")
guiFrame:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_LOGIN" then
    DEFAULT_CHAT_FRAME:AddMessage(string.format(
      "|cff33ff99WoWderhoi AHelper|r " .. L.LOADED, historyItemCount()))
    -- One line proves which build is running and which pipelines it found.
    DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoWderhoiAH|r tooltip pipeline: " .. pipelineFacts())
    if WAH.Ledger then WAH.Ledger.rebuild() end
    return
  end
  if event == "AUCTION_HOUSE_SHOW" then
    registerChartHost(WAH.ahFrame(), 0)
    -- The trader page is created later in this same event dispatch, so the
    -- second look happens on the next frame; its own OnShow also re-docks.
    C_Timer.After(0, function() WoWderhoiAH_UpdateChart() end)
  else
    hideChart()
  end
end)

SLASH_WOWDERHOIAHSTATUS1 = "/wah"
SlashCmdList["WOWDERHOIAHSTATUS"] = function()
  local scanInfo = L.STATUS_NO_SCAN
  if WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.scannedAt then
    local itemCount = 0
    for _, entry in pairs(WoWderhoiAH_ScanData.items or {}) do
      if entry.minPrice and entry.minPrice > 0 then itemCount = itemCount + 1 end
    end
    scanInfo = string.format(L.STATUS_LAST_SCAN,
      date("%m-%d %H:%M", WoWderhoiAH_ScanData.scannedAt), itemCount)
  end
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  DEFAULT_CHAT_FRAME:AddMessage(string.format(
    "|cff33ff99WoWderhoi AHelper|r " .. L.STATUS_FMT,
    historyItemCount(), scanInfo,
    WAH.currentPhase and WAH.currentPhase() or "?",
    ledger and coinString(ledger.capital.realized) or "0",
    ledger and coinString(ledger.capital.escrow) or "0"))
end

-- ============================== Price guide ========================

local function printPrice(itemId)
  local name = getItemInfo(itemId) or ("item:" .. tostring(itemId))
  local scanned = currentItem(itemId)
  local entry = historyFor(itemId)
  if not scanned and not entry then
    DEFAULT_CHAT_FRAME:AddMessage(string.format(
      "|cff33ff99WoWderhoiAH|r " .. L.PRICE_NO_DATA, name))
    return
  end
  local lines = { string.format(L.PRICE_HEADER, name) }
  if scanned and scanned.sellP then
    lines[#lines + 1] = string.format(L.PRICE_SELL, coinString(scanned.sellP))
    lines[#lines + 1] = string.format(L.PRICE_LIST,
      coinString(WAH.Core.listPrice(scanned.sellP, scanned.vendorP, WAH.RULES)))
  end
  if scanned then
    lines[#lines + 1] = string.format(L.PRICE_MIN, coinString(scanned.minPrice))
    local ladder = ladderText(scanned)
    if ladder then lines[#lines + 1] = string.format(L.PRICE_LADDER, ladder) end
    lines[#lines + 1] = string.format(L.PRICE_SUPPLY, scanned.quantity or 0, scanned.numAuctions or 0)
    lines[#lines + 1] = string.format(L.PRICE_P10, coinString(scanned.marketPrice or 0))
  end
  if entry then
    local window = entry.windowHours
    lines[#lines + 1] = string.format(L.PRICE_SELL_REF, window, coinString(entry.sellRef or 0))
    if scanned and scanned.sellP and entry.sellRef and entry.sellRef > 0 then
      lines[#lines + 1] = string.format(L.PRICE_TREND,
        (scanned.sellP - entry.sellRef) / entry.sellRef * 100, window)
    end
  end
  for _, line in ipairs(lines) do
    DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WAH|r " .. line)
  end
end

SLASH_WOWDERHOIAHPRICE1 = "/wahprice"
SlashCmdList["WOWDERHOIAHPRICE"] = function(input)
  local itemId
  if input and input ~= "" then
    itemId = WAH.itemIdFromLink(input) or tonumber(input)
  end
  if not itemId then
    local _, cursorItemId = GetCursorInfo()
    itemId = cursorItemId
  end
  if not itemId then
    DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoWderhoiAH|r " .. L.PRICE_USAGE)
    return
  end
  printPrice(itemId)
end

-- ============================== Diagnostics ========================

local function diagLine(text)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WAH diag|r " .. text)
end

SLASH_WOWDERHOIAHDIAG1 = "/wahdiag"
SlashCmdList["WOWDERHOIAHDIAG"] = function(input)
  if input and input:lower():match("^%s*mail%s*$") and WAH.Mail then
    for _, line in ipairs(WAH.Mail.diagnostics()) do diagLine(line) end
    return
  end
  local timeLeftValue, timeLeftType = "n/a", "missing"
  if C_AuctionHouse.GetReplicateItemTimeLeft then
    local ok, value = pcall(C_AuctionHouse.GetReplicateItemTimeLeft, 1)
    if ok then timeLeftValue, timeLeftType = tostring(value), type(value) end
  end
  diagLine(string.format("GetReplicateItemTimeLeft(1): %s (%s)", timeLeftValue, timeLeftType))

  local visible, hidden, items, points = 0, 0, 0, 0
  for _, entry in pairs(WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.items or {}) do
    if entry.minPrice and entry.minPrice > 0 then
      items = items + 1
      if entry.sellersInvisible then hidden = hidden + 1 else visible = visible + 1 end
    end
  end
  local market = WAH.seriesMarket and WAH.seriesMarket()
  if market then
    for _, series in pairs(market.items) do points = points + #series.t end
  end
  diagLine(string.format("owner visibility: %d visible / %d hidden / %d priced items", visible, hidden, items))
  local scanData = WoWderhoiAH_ScanData
  local selfListings, selfQty = 0, 0
  local byOwner, byOwned, byNone = 0, 0, 0
  if scanData then
    for _, entry in pairs(scanData.items or {}) do
      selfListings = selfListings + (entry.selfListings or 0)
      selfQty = selfQty + (entry.selfQty or 0)
      if entry.selfExclusion == "owner" then byOwner = byOwner + 1
      elseif entry.selfExclusion == "owned" then byOwned = byOwned + 1
      elseif entry.selfExclusion == "none" then byNone = byNone + 1 end
    end
  end
  diagLine(string.format("own listings excluded: %d listings / %d units | observation v%s",
    selfListings, selfQty, tostring(scanData and scanData.observationVersion or "n/a")))
  -- Which channel could identify the player's listings. "none" means the
  -- book may still contain them; those rows are not calibration evidence.
  diagLine(string.format("own exclusion channel: owner %d / owned %d / none %d items",
    byOwner, byOwned, byNone))
  diagLine(string.format("scan age: %s min, %s total auctions",
    tostring(WAH.scanAgeMinutes and math.floor(WAH.scanAgeMinutes() or -1) or -1),
    tostring(WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.total or 0)))
  diagLine(string.format("bags: %d free now | scan recorded %s",
    WAH.freeBagSlots(), tostring(WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.bagSlots or "none")))
  diagLine(string.format("series: %d points across %d items",
    points, historyItemCount()))
  -- The global cap no longer trims; it only asserts that the per-item budget
  -- arithmetic held. A nonzero count means history was not folded correctly.
  if (WAH.seriesCapViolation or 0) > 0 then
    diagLine(string.format("series cap violations: %d", WAH.seriesCapViolation))
  end
  local stats = WAH.lastScanStats
  -- The outcome line answers where the scan stopped and why. Without the
  -- phase and reason, "slow" and "unanswered" and "cleared copy" all looked
  -- like one failure that only a stopwatch could tell apart.
  diagLine(string.format(
    "last scan: %s | %s %d/%d rows | via %s | missing %d | bad %d | wait %.0f ms | api %.0f ms | lua %.0f ms | finish %.0f ms (max frame %.0f ms, %d frames) | save %.0f ms",
    stats and (stats.reason or "ok") or "none",
    stats and stats.phase or "idle",
    stats and stats.rows or 0, stats and stats.total or 0,
    stats and (stats.responseVia or "n/a") or "n/a",
    stats and stats.itemsMissingInfo or 0, stats and stats.badRows or 0,
    stats and stats.waitMs or 0, stats and stats.apiMs or 0,
    stats and stats.luaMs or 0, stats and stats.finishMs or 0,
    stats and stats.finishFrameMaxMs or 0, stats and stats.finishFrames or 0,
    stats and stats.saveMs or 0))
  -- A single "process" number could not answer whether the scan was slow in
  -- the client's replicate calls or in our own aggregation. The split does;
  -- the shares make the answer readable without arithmetic in the head.
  local waitMs = stats and stats.waitMs or 0
  local finishMs = stats and stats.finishMs or 0
  local saveMs = stats and stats.saveMs or 0
  local totalMs = waitMs + (stats and stats.apiMs or 0) + (stats and stats.luaMs or 0)
    + finishMs + saveMs
  local function share(value)
    if totalMs <= 0 then return 0 end
    return math.floor(value / totalMs * 100 + 0.5)
  end
  diagLine(string.format(
    "scan time split: api %d%% | lua %d%% | finish %d%% | save %d%% (wait %d%%)",
    share(stats and stats.apiMs or 0), share(stats and stats.luaMs or 0),
    share(finishMs), share(saveMs), share(waitMs)))
  diagLine(string.format("capture tiers: %d items",
    (function() local n = 0 for _ in pairs(WoWderhoiAH_Capture and WoWderhoiAH_Capture.items or {}) do n = n + 1 end return n end)()))
  diagLine(string.format("SaveAddOns: %s", C_AddOns and C_AddOns.SaveAddOns and "available" or "missing"))
  diagLine(string.format("PostItem/PostCommodity: %s/%s",
    C_AuctionHouse.PostItem and "present" or "missing",
    C_AuctionHouse.PostCommodity and "present" or "missing"))
  diagLine(string.format("ItemLocation:CreateFromBagAndSlot: %s",
    ItemLocation and ItemLocation.CreateFromBagAndSlot and "available" or "missing"))
  local deposit = "n/a"
  if C_AuctionHouse.CalculateCommodityDeposit then
    local ok, value = pcall(C_AuctionHouse.CalculateCommodityDeposit, 2589, 24, 1)
    deposit = ok and tostring(value) or "error"
  end
  diagLine(string.format("CalculateCommodityDeposit(2589,24,1): %s", deposit))
  diagLine(string.format("owned auctions: %s", tostring(
    C_AuctionHouse.GetNumOwnedAuctions and C_AuctionHouse.GetNumOwnedAuctions() or -1)))
  diagLine(string.format("throttle ready: %s", tostring(
    C_AuctionHouse.IsThrottledMessageSystemReady and C_AuctionHouse.IsThrottledMessageSystemReady() or "n/a")))
  local journal = WAH.Journal and WAH.Journal.count() or 0
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  diagLine(string.format("journal: %d events | realized (incl. inferred) %s | escrow %s | fees %s | deposits lost %s",
    journal,
    coinString(ledger and ledger.capital.realized or 0),
    coinString(ledger and ledger.capital.escrow or 0),
    coinString(ledger and ledger.capital.fees or 0),
    coinString(ledger and ledger.capital.depositsLost or 0)))
  diagLine(string.format("phase: %s (override %s, openedAt %s)", WAH.currentPhase and WAH.currentPhase() or "?",
    (WAH.settings and WAH.settings.phaseOverride) or "auto",
    (WAH.settings and WAH.settings.serverOpenedAt and WAH.settings.serverOpenedAt > 0)
      and tostring(WAH.settings.serverOpenedAt) or "auto"))
  diagLine(string.format("capture: mail %s | craft %s | pricing %s",
    (WAH.settings and WAH.settings.mailCapture == false) and "off" or "on",
    (WAH.settings and WAH.settings.craftCapture == false) and "off" or "on",
    (WAH.settings and WAH.settings.pricing == false) and "off" or "on"))
  diagLine(string.format("mail in transit: %s", coinString(
    WAH.Mail and WAH.Mail.pendingCash and WAH.Mail.pendingCash() or 0)))
  if WAH.Mail then
    for _, line in ipairs(WAH.Mail.diagnostics()) do diagLine(line) end
  end
  if WAH.Craft then
    for _, line in ipairs(WAH.Craft.diagnostics()) do diagLine(line) end
  end
end
