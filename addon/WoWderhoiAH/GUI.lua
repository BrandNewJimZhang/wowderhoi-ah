-- In-game price intelligence: trader tooltip section and a hand-drawn
-- line chart fed by WoWderhoiAH_Points, the scan-to-scan price points
-- the scanner accumulates in this client — no desktop roundtrip.

local ADDON_NAME, WAH = ...
local L = WAH.L

local EPOCH_DAY = 24 * 60 * 60

local function historyFor(itemId)
  return WAH.history and WAH.history(itemId)
end

local function trendText(latest, med7)
  if med7 == 0 then return "" end
  local delta = (latest - med7) / med7 * 100
  if delta > 3 then
    return string.format("|cffff5555" .. L.TT_TREND_VS .. "|r", delta)
  elseif delta < -3 then
    return string.format("|cff55ff55" .. L.TT_TREND_VS .. "|r", delta)
  end
  return string.format("|cffcccccc" .. L.TT_TREND_VS .. "|r", delta)
end

local function rangeText(entry)
  local minClose, maxClose = math.huge, 0
  for _, point in ipairs(entry.pts) do
    if point.c < minClose then minClose = point.c end
    if point.c > maxClose then maxClose = point.c end
  end
  if maxClose == 0 or maxClose == minClose then return nil end
  local percentile = (entry.latest - minClose) / (maxClose - minClose) * 100
  return string.format(L.TT_RANGE_NOW,
    GetCoinTextureString(minClose), GetCoinTextureString(maxClose), percentile)
end

-- Trader tooltip section: everywhere an item tooltip renders
-- (bags, AH, chat links, bank).
local lastTooltipItemId = nil
local chart = nil -- declared before the hooks below close over it

local function appendTraderSection(tooltip)
  if tooltip ~= GameTooltip then return end
  if tooltip.wahAppended then return end
  if WAH.settings and not WAH.settings.tooltip then return end
  local _, link = tooltip:GetItem()
  if not link then return end
  local itemId = tonumber(link:match("item:(%d+)"))
  if not itemId then return end
  lastTooltipItemId = itemId
  -- Session scan is the live view (AH prices swing by the hour);
  -- history is context. Show live first, one price per line.
  local scanned = WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.dataVersion == WAH.PIPELINE_VERSION
    and WoWderhoiAH_ScanData.items and WoWderhoiAH_ScanData.items[itemId]
  -- Old-pipeline scan on disk: rejected by the version gate, but say so
  -- visibly instead of silently dropping the section.
  local staleScan = not scanned and WoWderhoiAH_ScanData
    and WoWderhoiAH_ScanData.dataVersion ~= WAH.PIPELINE_VERSION and WoWderhoiAH_ScanData.items ~= nil
  local entry = historyFor(itemId)
  if not scanned and not entry and not staleScan then return end
  tooltip.wahAppended = true
  tooltip:AddLine(" ")
  tooltip:AddLine("|cff33ff99WoWderhoi AHelper|r")
  if staleScan then
    tooltip:AddLine("|cffff8800" .. L.TT_SCAN_STALE .. "|r")
  end
  if scanned then
    local age = math.floor((time() - (WoWderhoiAH_ScanData.scannedAt or time())) / 60)
    tooltip:AddDoubleLine(string.format(L.TT_SCAN_HEADER, age), "")
    -- Sell front leads every other price: it is the action anchor
    -- (what to list at), the rest is context. Orange to stand out.
    if scanned.sellP then
      tooltip:AddDoubleLine("  |cffff9933" .. L.TT_SELLP .. "|r", GetCoinTextureString(scanned.sellP))
    end
    tooltip:AddDoubleLine("  " .. L.TT_MIN, GetCoinTextureString(scanned.minPrice))
    if scanned.p5 then tooltip:AddDoubleLine("  P5", GetCoinTextureString(scanned.p5)) end
    tooltip:AddDoubleLine("  P10", GetCoinTextureString(scanned.marketPrice))
    tooltip:AddDoubleLine("  " .. L.TT_SUPPLY, string.format(L.TT_SUPPLY_FMT, scanned.quantity, scanned.numAuctions))
  end
  if entry then
    if scanned then tooltip:AddLine(" ") end
    tooltip:AddDoubleLine(L.TT_HISTORY_HEADER, "")
    tooltip:AddDoubleLine("  " .. L.TT_MED7, GetCoinTextureString(entry.med7))
    local trend = trendText(scanned and scanned.marketPrice or entry.latest, entry.med7)
    if trend ~= "" then tooltip:AddDoubleLine("  " .. L.TT_TREND, trend) end
    local range = rangeText(entry)
    if range then tooltip:AddDoubleLine("  " .. L.TT_RANGE, range) end
  end
  -- Trailing separator so the next addon's section does not glue to ours.
  tooltip:AddLine(" ")
  tooltip:Show()
  if WoWderhoiAH_UpdateChart then WoWderhoiAH_UpdateChart(itemId) end
end

-- Tooltip pipelines differ across client builds and cannot be probed
-- offline; register every known path and dedupe per tooltip show via
-- the wahAppended flag (cleared below when the tooltip resets).
GameTooltip:HookScript("OnTooltipCleared", function(tooltip) tooltip.wahAppended = nil end)
GameTooltip:HookScript("OnHide", function(tooltip)
  tooltip.wahAppended = nil
  if chart and not (AuctionFrame and AuctionFrame:IsShown()) then chart:Hide() end
end)

if TooltipDataProcessor and Enum and Enum.TooltipDataType then
  TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, appendTraderSection)
end
if GameTooltip:HasScript("OnTooltipSetItem") then
  GameTooltip:HookScript("OnTooltipSetItem", appendTraderSection)
end
for _, method in ipairs({
  "SetBagItem", "SetAuctionItem", "SetAuctionSellItem", "SetHyperlink",
  "SetInventoryItem", "SetMerchantItem", "SetGuildBankItem"
}) do
  if GameTooltip[method] then
    hooksecurefunc(GameTooltip, method, function(tooltip) appendTraderSection(tooltip) end)
  end
end

-- Hand-drawn line charts: scan-to-scan closes connected with Line
-- objects (frame:CreateLine, available on the 2.5.6 anniversary
-- client), anchored beside the auction frame. Two stacked windows over
-- the same point series: last 3 hours on top, last 48 hours below.
-- Each plot owns four separate rows — caption, high/low, plot box,
-- time row — one string per row, so label widths can never collide
-- with each other or with the line (font metrics are unknowable
-- offline, so overlap is prevented structurally, not by tuning).
local EPOCH_HOUR = 60 * 60
local CHART_WIDTH, CHART_HEIGHT = 280, 272
local PLOT_LEFT = 14
local PLOT_WIDTH, PLOT_HEIGHT = CHART_WIDTH - 28, 60
-- Row offsets from each plot's top edge.
local ROW_HILO, ROW_BOX, ROW_TIME = 14, 30, 92
local PLOT_LAYOUT = {
  { window = 3 * EPOCH_HOUR, captionKey = "CHART_RANGE_3H", top = 42 },
  { window = 48 * EPOCH_HOUR, captionKey = "CHART_RANGE_48H", top = 152 },
}

-- Chart price labels trim minor coins — gold prices drop copper,
-- 100g+ prices drop silver too — so the H/L string stays narrow
-- enough for one row. Full precision stays on the tooltip.
local COPPER_PER_SILVER, COPPER_PER_GOLD = 100, 100 * 100
local function coinLabel(amount)
  if amount >= 100 * COPPER_PER_GOLD then
    amount = amount - amount % COPPER_PER_GOLD
  elseif amount >= COPPER_PER_GOLD then
    amount = amount - amount % COPPER_PER_SILVER
  end
  return GetCoinTextureString(amount)
end

local function createPlot(layout)
  local plot = { window = layout.window, segments = {} }
  plot.caption = chart:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  plot.caption:SetPoint("TOPLEFT", PLOT_LEFT, -layout.top)
  plot.caption:SetText(L[layout.captionKey])
  plot.hilo = chart:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  plot.hilo:SetPoint("TOPLEFT", PLOT_LEFT, -(layout.top + ROW_HILO))
  plot.startLabel = chart:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  plot.startLabel:SetPoint("TOPLEFT", PLOT_LEFT, -(layout.top + ROW_TIME))
  plot.endLabel = chart:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  plot.endLabel:SetPoint("TOPRIGHT", -PLOT_LEFT, -(layout.top + ROW_TIME))
  -- Line/dot offsets anchor from the frame's BOTTOMLEFT.
  plot.bottom = CHART_HEIGHT - layout.top - ROW_BOX - PLOT_HEIGHT
  plot.dot = chart:CreateTexture(nil, "OVERLAY")
  plot.dot:SetColorTexture(1.0, 1.0, 1.0, 1.0)
  plot.dot:SetSize(4, 4)
  plot.dot:Hide()
  return plot
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
  chart.plots = {}
  for index, layout in ipairs(PLOT_LAYOUT) do
    chart.plots[index] = createPlot(layout)
  end
  chart:Hide()
end

local function renderPlot(plot, pts, now)
  local cutoff = now - plot.window
  local points = {}
  for _, point in ipairs(pts) do
    if point.t >= cutoff then points[#points + 1] = point end
  end
  if #points < 2 then
    plot.hilo:SetText(L.CHART_EMPTY)
    plot.startLabel:SetText("")
    plot.endLabel:SetText("")
    for _, segment in ipairs(plot.segments) do segment:Hide() end
    plot.dot:Hide()
    return
  end
  local minClose, maxClose = math.huge, 0
  for _, point in ipairs(points) do
    if point.c < minClose then minClose = point.c end
    if point.c > maxClose then maxClose = point.c end
  end
  plot.hilo:SetText(string.format(L.CHART_HILO,
    coinLabel(maxClose), coinLabel(minClose)))

  -- X is proportional to real time (t = epoch seconds): a two-hour gap
  -- in scanning renders as a two-hour-wide gap on the axis. Labels use
  -- clock time for intraday spans, dates once the span crosses a day.
  local firstT, lastT = points[1].t, points[#points].t
  local timeSpan = math.max(lastT - firstT, 1)
  local labelFormat = timeSpan < EPOCH_DAY and "%H:%M" or "%m-%d %H:%M"
  plot.startLabel:SetText(date(labelFormat, firstT))
  plot.endLabel:SetText(date(labelFormat, lastT))

  local range = maxClose - minClose
  local function plotXY(point)
    local x = PLOT_LEFT + (point.t - firstT) / timeSpan * PLOT_WIDTH
    -- Flat series draw at mid-height instead of hugging the bottom row.
    local ratio = range > 0 and (point.c - minClose) / range or 0.5
    return x, plot.bottom + ratio * PLOT_HEIGHT
  end

  for index = 1, #points - 1 do
    local segment = plot.segments[index]
    if not segment then
      segment = chart:CreateLine(nil, "ARTWORK")
      segment:SetThickness(2)
      plot.segments[index] = segment
    end
    local x1, y1 = plotXY(points[index])
    local x2, y2 = plotXY(points[index + 1])
    segment:SetStartPoint("BOTTOMLEFT", chart, x1, y1)
    segment:SetEndPoint("BOTTOMLEFT", chart, x2, y2)
    -- Fade older segments so the recent trend reads first.
    local recency = index / #points
    segment:SetColorTexture(0.2, 0.7 + 0.3 * recency, 0.5 + 0.1 * recency, 0.5 + 0.5 * recency)
    segment:Show()
  end
  for index = #points, #plot.segments do
    plot.segments[index]:Hide()
  end
  local dotX, dotY = plotXY(points[#points])
  plot.dot:ClearAllPoints()
  plot.dot:SetPoint("CENTER", chart, "BOTTOMLEFT", dotX, dotY)
  plot.dot:Show()
end

function WoWderhoiAH_UpdateChart(itemId)
  if WAH.settings and not WAH.settings.chart then
    if chart then chart:Hide() end
    return
  end
  if not chart then createChart() end
  local entry = historyFor(itemId)
  if not entry or not entry.pts or #entry.pts < 2 then
    chart:Hide()
    return
  end
  -- Follow the tooltip: anchored beside the AH when it is open,
  -- beside the game tooltip otherwise.
  chart:ClearAllPoints()
  if AuctionFrame and AuctionFrame:IsShown() then
    chart:SetPoint("TOPLEFT", AuctionFrame, "TOPRIGHT", -2, -12)
  elseif GameTooltip:IsShown() then
    chart:SetPoint("TOPRIGHT", GameTooltip, "TOPLEFT", -4, 0)
  else
    chart:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
  end
  local itemName = GetItemInfo(itemId) or ("item:" .. itemId)
  chart.title:SetText(itemName)
  chart.subtitle:SetText(string.format(L.CHART_SUBTITLE, #entry.pts, GetCoinTextureString(entry.latest)))

  local now = time()
  for _, plot in ipairs(chart.plots) do
    renderPlot(plot, entry.pts, now)
  end
  chart:Show()
end

local guiFrame = CreateFrame("Frame")
guiFrame:RegisterEvent("PLAYER_LOGIN")
guiFrame:RegisterEvent("AUCTION_HOUSE_SHOW")
guiFrame:RegisterEvent("AUCTION_HOUSE_CLOSED")
guiFrame:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_LOGIN" then
    local count = 0
    if WoWderhoiAH_Points then
      for _ in pairs(WoWderhoiAH_Points) do count = count + 1 end
    end
    DEFAULT_CHAT_FRAME:AddMessage(string.format(
      "|cff33ff99WoWderhoi AHelper|r " .. L.LOADED, count))
    return
  end
  if event == "AUCTION_HOUSE_SHOW" then
    if lastTooltipItemId then WoWderhoiAH_UpdateChart(lastTooltipItemId) end
  elseif chart then
    chart:Hide()
  end
end)

SLASH_WOWDERHOIAHSTATUS1 = "/wah"
SlashCmdList["WOWDERHOIAHSTATUS"] = function()
  local historyCount = 0
  if WoWderhoiAH_Points then
    for _ in pairs(WoWderhoiAH_Points) do historyCount = historyCount + 1 end
  end
  local scanInfo = L.STATUS_NO_SCAN
  if WoWderhoiAH_ScanData and WoWderhoiAH_ScanData.scannedAt then
    local itemCount = 0
    for _ in pairs(WoWderhoiAH_ScanData.items or {}) do itemCount = itemCount + 1 end
    scanInfo = string.format(L.STATUS_LAST_SCAN,
      date("%m-%d %H:%M", WoWderhoiAH_ScanData.scannedAt), itemCount)
  end
  DEFAULT_CHAT_FRAME:AddMessage(string.format(
    "|cff33ff99WoWderhoi AHelper|r " .. L.STATUS_FMT, historyCount, scanInfo))
end
