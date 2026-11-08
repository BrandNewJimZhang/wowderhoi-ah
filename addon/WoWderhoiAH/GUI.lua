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

-- Trader tooltip section: everywhere an item tooltip renders
-- (bags, AH, chat links, bank).
local lastTooltipItemId = nil
local chart = nil

-- The chart is anchored beside an item tooltip, and the tooltip hides the
-- moment the pointer leaves the item. Hiding the chart with it made the
-- mode and window buttons unreachable: they disappeared before the pointer
-- could cross the gap. Instead the chart survives a short grace period and
-- stays while the pointer is on it, so its buttons can actually be clicked.
local CHART_HIDE_DELAY = 0.6
local chartHideToken = 0

local function cancelChartHide()
  chartHideToken = chartHideToken + 1
end

local function scheduleChartHide()
  cancelChartHide()
  local token = chartHideToken
  C_Timer.After(CHART_HIDE_DELAY, function()
    if token ~= chartHideToken then return end
    if not chart or not chart:IsShown() then return end
    if chart.wahHovered or GameTooltip:IsShown() then return end
    chart:Hide()
  end)
end

local function hideChart()
  cancelChartHide()
  if chart then
    chart.wahHovered = nil
    chart:Hide()
  end
end

local function appendTraderSection(tooltip, hyperlink)
  if tooltip ~= GameTooltip then return end
  if tooltip.wahAppended then return end
  if WAH.settings and not WAH.settings.tooltip then return end
  -- SetHyperlink serves spell and unit buttons too, and the client reuses
  -- one GameTooltip: after an item hover, a non-item hyperlink can still
  -- report that old item through GetItem(). Only a link that is itself an
  -- item may carry the trader section; otherwise the price panel appeared
  -- on talent and character buttons.
  local itemId
  if hyperlink ~= nil then
    itemId = WAH.itemIdFromLink(hyperlink)
  else
    local _, link = tooltip:GetItem()
    itemId = WAH.itemIdFromLink(link)
  end
  if not itemId then return end
  lastTooltipItemId = itemId
  local scanned = currentItem(itemId)
  -- Inspect the raw global on purpose: this is the one place that must tell
  -- "no scan yet" apart from "a scan from another pipeline is on disk".
  local raw = WoWderhoiAH_ScanData
  local staleScan = not scanned and type(raw) == "table"
    and raw.dataVersion ~= WAH.PIPELINE_VERSION and raw.items ~= nil
  local entry = historyFor(itemId)
  if not scanned and not entry and not staleScan then return end
  tooltip.wahAppended = true
  tooltip:AddLine(" ")
  tooltip:AddLine("|cff33ff99WoWderhoi AHelper|r")
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
  tooltip:Show()
  if WoWderhoiAH_UpdateChart then WoWderhoiAH_UpdateChart(itemId) end
end

GameTooltip:HookScript("OnTooltipCleared", function(tooltip) tooltip.wahAppended = nil end)
GameTooltip:HookScript("OnHide", function(tooltip)
  tooltip.wahAppended = nil
  if not chart then return end
  -- With the auction house open the chart is anchored to the panel, not to
  -- the tooltip, and stays as it always has. Otherwise it lingers for a
  -- moment -- cancelled by moving onto it -- so the buttons are reachable.
  local auctionHouse = WAH.ahFrame and WAH.ahFrame()
  if auctionHouse and auctionHouse:IsShown() then return end
  if chart.wahHovered then return end
  scheduleChartHide()
end)

if TooltipDataProcessor and Enum and Enum.TooltipDataType then
  -- The post-call passes (tooltip, tooltipData); wrap it so the data table
  -- is not mistaken for a hyperlink.
  TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, function(tooltip)
    appendTraderSection(tooltip)
  end)
end
if GameTooltip:HasScript("OnTooltipSetItem") then
  GameTooltip:HookScript("OnTooltipSetItem", function(tooltip) appendTraderSection(tooltip) end)
end
for _, method in ipairs({
  "SetBagItem", "SetAuctionItem", "SetAuctionSellItem",
  "SetInventoryItem", "SetMerchantItem", "SetGuildBankItem"
}) do
  if GameTooltip[method] then
    hooksecurefunc(GameTooltip, method, function(tooltip) appendTraderSection(tooltip) end)
  end
end
-- Hyperlinks carry their own type, so the hook hands the link to the gate
-- instead of trusting whatever the shared tooltip still holds.
if GameTooltip.SetHyperlink then
  hooksecurefunc(GameTooltip, "SetHyperlink", function(tooltip, link)
    appendTraderSection(tooltip, link)
  end)
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

-- "All" means the whole retained series, not the phase window. The series
-- keeps a month (WoWderhoiAH.lua's pruneSeries), so ask for a month and let
-- WAH.history return every point it still holds.
local ALL_HOURS = 30 * 24

local chartMode = nil -- nil = automatic: book with <2 points, time otherwise
local chartWindow = nil -- nil = phase default

local function phaseWindow()
  local phase = WAH.currentPhase and WAH.currentPhase() or "steady"
  if phase == "ignition" then return 0 end
  if phase == "wave" then return 6 end
  return 24
end

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
    setState({ mode = "book", points = 0, title = chart.title:GetText() })
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

  local dotCount = 0
  dotCount = dotCount + 1
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
    min = minP,
    max = maxP,
    sellP = entry.sellP,
    supply = total,
    title = chart.title:GetText()
  })
end

local function medianInterval(points)
  if #points < 3 then return nil end
  local gaps = {}
  for index = 2, #points do gaps[#gaps + 1] = points[index].t - points[index - 1].t end
  -- Same lower-median rule as the terminal's gap detector (median.ts), so
  -- a scan outage breaks the line at the same place in both charts.
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
  if #points < 2 then
    chart.hilo:SetText(L.CHART_EMPTY)
    chart.startLabel:SetText("")
    chart.endLabel:SetText("")
    hideFrom(chart.segments, 1)
    hideBarsFrom(1)
    hideDotsFrom(1)
    setState({ mode = "time", window = windowHours, points = #points, title = chart.title:GetText() })
    return
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
  if minPrice == math.huge or maxPrice == 0 then
    chart.hilo:SetText(L.CHART_EMPTY)
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
    min = minPrice,
    max = maxPrice,
    logScale = logScale,
    sellRef = entry.sellRef,
    title = chart.title:GetText(),
    segments = segmentCount,
    bars = barCount
  })
end

local function renderChart(itemId)
  local entry = currentItem(itemId)
  -- Read the whole retained series and let the selected window filter what
  -- is drawn. Fetching the phase window here made the 24h/7d/all buttons
  -- redraw the same handful of points in wave and settle.
  local window = chartWindow or phaseWindow()
  local history = historyFor(itemId, ALL_HOURS)
  if not entry and not history then hideChart() return end
  local auctionHouse = WAH.ahFrame and WAH.ahFrame()
  local tradePage = WAH.tradeFrame and WAH.tradeFrame()
  -- Keep the frame where the player found it. A window/mode click happens
  -- after the tooltip has already closed, so re-anchoring to the screen
  -- centre then would make the chart jump out from under the pointer.
  if tradePage and tradePage:IsShown() then
    chart:ClearAllPoints()
    chart:SetPoint("TOPLEFT", tradePage, "TOPRIGHT", 4, -12)
    chart.wahAnchor = "trade"
  elseif auctionHouse and auctionHouse:IsShown() then
    chart:ClearAllPoints()
    chart:SetPoint("TOPLEFT", auctionHouse, "TOPRIGHT", 4, -12)
    chart.wahAnchor = "auction"
  elseif GameTooltip:IsShown() then
    chart:ClearAllPoints()
    chart:SetPoint("TOPRIGHT", GameTooltip, "TOPLEFT", -4, 0)
    chart.wahAnchor = "tooltip"
  elseif chart.wahAnchor ~= "tooltip" then
    chart:ClearAllPoints()
    chart:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
    chart.wahAnchor = "center"
  end
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
      shown, coinString(history.latest or 0), window > 0 and window or L.CHART_ALL_LABEL))
  end
  for _, button in ipairs(chart.modeButtons) do
    button:SetText(button.mode == mode and ("|cffffd100" .. button.label .. "|r") or button.label)
  end
  for _, button in ipairs(chart.windowButtons) do
    button:SetShown(mode == "time")
    button:SetText(button.hours == window and ("|cffffd100" .. button.label .. "|r") or button.label)
  end
  -- A new item or a button press re-renders: any pending hide is stale.
  cancelChartHide()
  chart:Show()
end

local function createChart()
  chart = CreateFrame("Frame", "WoWderhoiAHChart", UIParent, "BackdropTemplate")
  chart:SetSize(CHART_WIDTH, CHART_HEIGHT)
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

  chart.modeButtons = {}
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
  -- Mouse-enabled so moving onto the chart can cancel the tooltip's hide
  -- timer; without it the buttons could never be reached.
  chart:EnableMouse(true)
  chart:SetScript("OnEnter", function(self)
    self.wahHovered = true
    cancelChartHide()
  end)
  chart:SetScript("OnLeave", function(self)
    self.wahHovered = nil
    if not GameTooltip:IsShown() then scheduleChartHide() end
  end)
  chart:Hide()
end

function WoWderhoiAH_UpdateChart(itemId)
  if WAH.settings and not WAH.settings.chart then
    hideChart()
    return
  end
  if not chart then createChart() end
  lastTooltipItemId = itemId
  renderChart(itemId)
end

function WAH.setChartMode(mode)
  chartMode = mode
  if lastTooltipItemId and chart then renderChart(lastTooltipItemId) end
end

function WAH.setChartWindow(hours)
  chartWindow = hours
  chartMode = "time"
  if lastTooltipItemId and chart then renderChart(lastTooltipItemId) end
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
    local count = 0
    local market = WAH.seriesMarket and WAH.seriesMarket()
    if market then
      for _ in pairs(market.items) do count = count + 1 end
    end
    DEFAULT_CHAT_FRAME:AddMessage(string.format(
      "|cff33ff99WoWderhoi AHelper|r " .. L.LOADED, count))
    if WAH.Ledger then WAH.Ledger.rebuild() end
    return
  end
  if event == "AUCTION_HOUSE_SHOW" then
    if lastTooltipItemId then WoWderhoiAH_UpdateChart(lastTooltipItemId) end
  else
    hideChart()
  end
end)

SLASH_WOWDERHOIAHSTATUS1 = "/wah"
SlashCmdList["WOWDERHOIAHSTATUS"] = function()
  local market = WAH.seriesMarket and WAH.seriesMarket()
  local historyCount = 0
  if market then
    for _ in pairs(market.items) do historyCount = historyCount + 1 end
  end
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
    historyCount, scanInfo,
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
    points, market and (function() local n = 0 for _ in pairs(market.items) do n = n + 1 end return n end)() or 0))
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
