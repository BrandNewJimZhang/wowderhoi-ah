-- Settings: SavedVariable-backed options shared across addon files via
-- the private addon namespace (WAH). WoWderhoiAH_Settings is the single
-- authority; every toggle reads/writes it, including /wahauto.

local ADDON_NAME, WAH = ...
local L = WAH.L

local DEFAULTS = {
  autoScan = false, -- rescan on the compiled cadence while the AH stays open
  tooltip = true, -- trader section on item tooltips
  chart = true, -- price chart panel beside the auction frame
  tradeOnOpen = true, -- open the WAH deal page with the auction house
  phaseOverride = "auto", -- "ignition" | "wave" | "settle" | "steady" | "auto"
  -- Capture switches double as rollback levers: turned off, the system
  -- falls back to inferred sales and per-row quantities.
  mailCapture = true, -- read collected sales from the mailbox
  craftCapture = true, -- record crafts from TRADE_SKILL events
  -- Price x duration search on the sell page. Off, the page posts the
  -- one-copper undercut at the selected duration, which is what a player
  -- who does not trust the model wants.
  pricing = true,
  serverOpenedAt = 0, -- epoch seconds; 0 = derive age from the first scan
  -- Replicate admission, persisted so /reload cannot reset the clock. Every
  -- request advances lastReplicateAt; retryAfter is set only by a failed
  -- request. The client exposes no cooldown query, so this is the one
  -- authority both the manual command and the auto ticker consult.
  lastReplicateAt = 0,
  retryAfter = 0
}

WAH.settings = nil -- assigned at ADDON_LOADED once SavedVariables exist

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, name)
  if name ~= ADDON_NAME then return end
  WoWderhoiAH_Settings = WoWderhoiAH_Settings or {}
  for key, value in pairs(DEFAULTS) do
    if WoWderhoiAH_Settings[key] == nil then WoWderhoiAH_Settings[key] = value end
  end
  WAH.settings = WoWderhoiAH_Settings
end)

-- Options panel, Auctionator-style: checkboxes registered under the
-- standard game Options > AddOns list.
local panel = CreateFrame("Frame")
panel.name = "WoWderhoi AHelper"

local scanMinutes = (WAH.RULES and WAH.RULES.scanIntervalMinutes) or 15
local OPTIONS = {
  { key = "autoScan", label = L.OPT_AUTOSCAN, tip = string.format(L.OPT_AUTOSCAN_TIP, scanMinutes) },
  { key = "tooltip", label = L.OPT_TOOLTIP, tip = L.OPT_TOOLTIP_TIP },
  { key = "chart", label = L.OPT_CHART, tip = L.OPT_CHART_TIP },
  { key = "tradeOnOpen", label = L.OPT_TRADE_ON_OPEN, tip = L.OPT_TRADE_ON_OPEN_TIP },
  { key = "pricing", label = L.OPT_PRICING, tip = L.OPT_PRICING_TIP }
}

panel:SetScript("OnShow", function(self)
  if self.built then
    for _, checkbox in ipairs(self.checkboxes) do
      checkbox:SetChecked(WAH.settings and WAH.settings[checkbox.settingKey])
    end
    return
  end
  self.built = true
  self.checkboxes = {}

  local title = self:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
  title:SetPoint("TOPLEFT", 16, -16)
  title:SetText("WoWderhoi AHelper")

  local subtitle = self:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
  subtitle:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -6)
  subtitle:SetText(L.OPT_SUBTITLE)

  local anchor = subtitle
  for index, option in ipairs(OPTIONS) do
    local checkbox = CreateFrame("CheckButton", "WoWderhoiAHOption" .. index, self, "InterfaceOptionsCheckButtonTemplate")
    checkbox:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, index == 1 and -16 or -8)
    checkbox.Text:SetText(option.label)
    checkbox.tooltipText = option.tip
    checkbox.settingKey = option.key
    checkbox:SetChecked(WAH.settings and WAH.settings[option.key])
    checkbox:SetScript("OnClick", function(button)
      WAH.settings[button.settingKey] = button:GetChecked() and true or false
    end)
    self.checkboxes[index] = checkbox
    anchor = checkbox
  end
end)

if Settings and Settings.RegisterCanvasLayoutCategory then
  local category = Settings.RegisterCanvasLayoutCategory(panel, panel.name)
  Settings.RegisterAddOnCategory(category)
  WAH.openSettings = function() Settings.OpenToCategory(category:GetID()) end
else
  InterfaceOptions_AddCategory(panel)
  WAH.openSettings = function()
    -- Long-standing Blizzard bug: the first call only opens the window
    -- without navigating; calling twice lands on the category.
    InterfaceOptionsFrame_OpenToCategory(panel)
    InterfaceOptionsFrame_OpenToCategory(panel)
  end
end

SLASH_WOWDERHOIAHOPTS1 = "/wahopt"
SlashCmdList["WOWDERHOIAHOPTS"] = function() WAH.openSettings() end
