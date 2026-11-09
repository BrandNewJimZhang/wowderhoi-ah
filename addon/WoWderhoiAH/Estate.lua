-- Private asset state. The auction book is a slow pull (ReplicateItems); the
-- player's bag, bank, mailbox, cash and own postings are local client state
-- that changes between scans. Publishing them in the scan snapshot froze
-- them at scan time, so the terminal and the in-game radar answered "what
-- next" from different purses and bags.
--
-- This module is the single publisher of that state. Events only mark the
-- snapshot dirty; a debounced pass rebuilds it, and a revision moves only
-- when the content actually changed. Positions carry a coverage flag per
-- location: a bank that was never opened is `unobserved`, never an empty
-- bank.
--
-- Scope split:
--   character:<name>  bag, reagent bag, keyring, character bank, mailbox,
--                     cash, free slots
--   account           account bank, own auction postings (the client's
--                     QueryOwnedAuctions answers for the whole account)

local ADDON_NAME, WAH = ...

local Estate = {}
Estate.VERSION = 1
-- The client fires a burst of BAG_UPDATE_DELAYED/PLAYER_MONEY events around
-- a loot or a purchase. One rebuild after the burst is enough; the watcher
-- polls at five seconds, so this delay is not the export latency.
Estate.DEBOUNCE_SECONDS = 1.5
-- SavedVariables is one file: every flush rewrites the whole scan as well.
-- State saves are spaced so a mailbox sweep cannot rewrite the file once per
-- message. The in-game reader always sees the in-memory snapshot.
Estate.SAVE_SECONDS = 20

local BAG_FIRST, BAG_LAST = 0, 4
local REAGENT_BAG = 5
local KEYRING = -1
local BANK_FIRST, BANK_LAST = 6, 14
local ACCOUNT_BANK_FIRST, ACCOUNT_BANK_LAST = 15, 23

local dirty = false
local debounceTimer = nil
local saveTimer = nil
local lastSaveAt = 0
local bankObserved = false
local bankOpen = false
-- Container contents are only promised while the bank is open. The last
-- observed bank is cached so a money or bag event after the bank closes
-- cannot turn the cache into an empty bank.
local bankCache = nil
local mailObserved = false
local ownedObserved = false

local function characterName()
  return (UnitName and UnitName("player")) or "Unknown"
end

local function characterScope()
  return "character:" .. characterName()
end

local function addItem(items, itemId, location, qty, slots)
  if not itemId or qty <= 0 then return end
  local byLocation = items[itemId]
  if not byLocation then
    byLocation = {}
    items[itemId] = byLocation
  end
  local entry = byLocation[location]
  if not entry then
    entry = { qty = 0, slots = 0 }
    byLocation[location] = entry
  end
  entry.qty = entry.qty + qty
  entry.slots = entry.slots + (slots or 1)
end

local function scanContainer(items, bag, location)
  if not (C_Container and C_Container.GetContainerNumSlots and C_Container.GetContainerItemInfo) then
    return
  end
  local slots = C_Container.GetContainerNumSlots(bag) or 0
  for slot = 1, slots do
    local info = C_Container.GetContainerItemInfo(bag, slot)
    if info and info.itemID and (info.stackCount or 0) > 0 then
      addItem(items, info.itemID, location, info.stackCount, 1)
    end
  end
end

local function scanCarried(items)
  for bag = BAG_FIRST, BAG_LAST do scanContainer(items, bag, "carried") end
  scanContainer(items, REAGENT_BAG, "carried")
  scanContainer(items, KEYRING, "keyring")
end

local function copyBankCache(items)
  for itemId, byLocation in pairs(bankCache or {}) do
    for location, entry in pairs(byLocation) do
      if location == "bank" or location == "account_bank" then
        addItem(items, itemId, location, entry.qty, entry.slots)
      end
    end
  end
end

local function scanBank(items)
  if not bankObserved then return end
  if not bankOpen then
    copyBankCache(items)
    return
  end
  local fresh = {}
  for bag = BANK_FIRST, BANK_LAST do scanContainer(fresh, bag, "bank") end
  for bag = ACCOUNT_BANK_FIRST, ACCOUNT_BANK_LAST do
    scanContainer(fresh, bag, "account_bank")
  end
  bankCache = fresh
  copyBankCache(items)
end

local function scanMail(items)
  if not mailObserved then return 0, nil end
  if not (GetInboxNumItems and GetInboxHeaderInfo and GetInboxItemLink) then return 0, nil end
  local ok, count = pcall(GetInboxNumItems)
  if not ok or not count then return 0, nil end
  local pendingCash = 0
  for message = 1, count do
    local okHeader, header = pcall(function() return { GetInboxHeaderInfo(message) } end)
    if okHeader and header then
      pendingCash = pendingCash + (header[5] or 0)
      -- A COD attachment is not owned until it is paid; counting it would
      -- put someone else's goods in the player's holdings.
      local cod = header[6] or 0
      local attachments = cod > 0 and 0 or (header[13] or 0)
      for attachment = 1, attachments do
        -- GetInboxItem carries the stack count; the link is the fallback
        -- for builds that only expose it.
        local counted = false
        if type(GetInboxItem) == "function" then
          local okItem, _, itemId, _, count = pcall(GetInboxItem, message, attachment)
          if okItem and itemId then
            addItem(items, itemId, "mail", count or 1, 1)
            counted = true
          end
        end
        if not counted then
          local okLink, link = pcall(GetInboxItemLink, message, attachment)
          if okLink and link then
            local itemId = tonumber(tostring(link):match("item:(%d+)"))
            if itemId then addItem(items, itemId, "mail", 1, 1) end
          end
        end
      end
    end
  end
  return pendingCash, count
end

-- Own postings are still owned. They belong to the account, but the
-- character that opened the auction house is the one whose mailbox and
-- ledger will observe the outcome, so the quantity is listed under the
-- account scope and the character scope does not duplicate it.
local function scanOwned(items)
  if not ownedObserved then return end
  if not WAH.ownedAuctions then return end
  for _, row in ipairs(WAH.ownedAuctions()) do
    addItem(items, row.itemId, "listed", row.quantity or 1, 1)
  end
end

local function freeBagSlots()
  if not (C_Container and C_Container.GetContainerNumFreeSlots) then return 20 end
  local total = 0
  for bag = BAG_FIRST, BAG_LAST do
    total = total + (C_Container.GetContainerNumFreeSlots(bag) or 0)
  end
  return total
end

local function coverage(observed)
  return observed and "observed" or "unobserved"
end

local function build()
  local characterItems = {}
  scanCarried(characterItems)
  scanBank(characterItems)
  local pendingCash, mailCount = scanMail(characterItems)
  local accountItems = {}
  -- Bank scanning above already wrote account_bank rows into the character
  -- table; move them. Keeping one table until now avoids scanning the same
  -- containers twice.
  for itemId, byLocation in pairs(characterItems) do
    local account = byLocation.account_bank
    if account then
      byLocation.account_bank = nil
      addItem(accountItems, itemId, "account_bank", account.qty, account.slots)
      if next(byLocation) == nil then characterItems[itemId] = nil end
    end
  end
  scanOwned(accountItems)

  local now = time()
  local snapshot = {
    v = Estate.VERSION,
    observedAt = now,
    scopes = {
      [characterScope()] = {
        kind = "character",
        name = characterName(),
        cash = GetMoney and GetMoney() or 0,
        freeSlots = freeBagSlots(),
        pendingCash = pendingCash,
        mailCount = mailCount or 0,
        coverage = {
          carried = "observed",
          keyring = "observed",
          bank = coverage(bankObserved),
          mail = coverage(mailObserved),
          money = "observed"
        },
        items = characterItems
      },
      account = {
        kind = "account",
        coverage = {
          account_bank = coverage(bankObserved),
          listed = coverage(ownedObserved)
        },
        items = accountItems
      }
    }
  }
  -- Reconciliation is derived from the snapshot and the ledger. Attaching
  -- it here keeps one document for the terminal; Estate.same ignores it so
  -- a ledger-only change does not move the estate revision.
  if WAH.Reconciler then snapshot.reconciled = WAH.Reconciler.run(snapshot) end
  local existing = WoWderhoiAH_Estate
  local revision = existing and existing.revision or 0
  if not Estate.same(snapshot, existing) then
    revision = revision + 1
  elseif existing then
    -- An unchanged snapshot must not move observedAt: the watcher keys its
    -- state watermark on (revision, observedAt), so a moving timestamp
    -- would make every idle rebuild look like new state.
    snapshot.observedAt = existing.observedAt
  end
  snapshot.revision = revision
  return snapshot
end

local function sameEntry(left, right)
  return left ~= nil and right ~= nil
    and (left.qty or 0) == (right.qty or 0)
    and (left.slots or 0) == (right.slots or 0)
end

local function sameItems(left, right)
  for itemId, byLocation in pairs(left or {}) do
    local other = right and right[itemId]
    if not other then return false end
    for location, entry in pairs(byLocation) do
      if not sameEntry(entry, other[location]) then return false end
    end
    for location in pairs(other) do
      if not byLocation[location] then return false end
    end
  end
  for itemId in pairs(right or {}) do
    if not left[itemId] then return false end
  end
  return true
end

local function sameCoverage(left, right)
  for key, value in pairs(left or {}) do
    if not right or right[key] ~= value then return false end
  end
  for key in pairs(right or {}) do
    if not left[key] then return false end
  end
  return true
end

-- Content equality, not timestamp equality: a debounced rebuild that found
-- the same bag must not move the revision the plan is keyed on.
function Estate.same(left, right)
  if not left or not right then return false end
  for scopeKey, scope in pairs(left.scopes or {}) do
    local other = right.scopes and right.scopes[scopeKey]
    if not other then return false end
    if (scope.cash or 0) ~= (other.cash or 0) then return false end
    if (scope.freeSlots or 0) ~= (other.freeSlots or 0) then return false end
    if (scope.pendingCash or 0) ~= (other.pendingCash or 0) then return false end
    if not sameCoverage(scope.coverage, other.coverage) then return false end
    if not sameItems(scope.items, other.items) then return false end
  end
  for scopeKey in pairs(right.scopes or {}) do
    if not (left.scopes and left.scopes[scopeKey]) then return false end
  end
  return true
end

function Estate.requestSave()
  local now = time()
  local elapsed = now - lastSaveAt
  if elapsed >= Estate.SAVE_SECONDS then
    lastSaveAt = now
    if WAH.requestFlush then WAH.requestFlush(1) end
    return
  end
  if saveTimer then return end
  saveTimer = C_Timer.NewTimer(Estate.SAVE_SECONDS - elapsed, function()
    saveTimer = nil
    lastSaveAt = time()
    if WAH.requestFlush then WAH.requestFlush(1) end
  end)
end

-- Rebuild and publish. Returns the snapshot and whether the revision moved.
function Estate.refresh(force)
  if dirty or force then
    dirty = false
    local snapshot = build()
    local previous = WoWderhoiAH_Estate
    WoWderhoiAH_Estate = snapshot
    local changed = not previous or previous.revision ~= snapshot.revision
    if changed then Estate.requestSave() end
    return snapshot, changed
  end
  return WoWderhoiAH_Estate, false
end

function Estate.markDirty()
  dirty = true
  if debounceTimer then return end
  if not (C_Timer and C_Timer.NewTimer) then
    Estate.refresh(true)
    return
  end
  debounceTimer = C_Timer.NewTimer(Estate.DEBOUNCE_SECONDS, function()
    debounceTimer = nil
    Estate.refresh()
  end)
end

function Estate.snapshot()
  return WoWderhoiAH_Estate or Estate.refresh(true)
end

function Estate.revision()
  local snapshot = Estate.snapshot()
  return snapshot and snapshot.revision or 0
end

function Estate.scope(scopeKey)
  local snapshot = Estate.snapshot()
  return snapshot and snapshot.scopes and snapshot.scopes[scopeKey] or nil
end

function Estate.currentCharacterScope()
  return Estate.scope(characterScope())
end

function Estate.characterKey()
  return characterScope()
end

function Estate.isBankObserved() return bankObserved end
function Estate.isMailObserved() return mailObserved end
function Estate.isOwnedObserved() return ownedObserved end

-- The client only promises container contents while the bank is open. The
-- coverage flag is latched for the session; closing the bank does not throw
-- away what was observed, and a later change event re-reads it.
local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("BAG_UPDATE_DELAYED")
frame:RegisterEvent("PLAYER_MONEY")
frame:RegisterEvent("BANKFRAME_OPENED")
frame:RegisterEvent("BANKFRAME_CLOSED")
frame:RegisterEvent("PLAYERBANKSLOTS_CHANGED")
frame:RegisterEvent("PLAYER_ACCOUNT_BANK_TAB_SLOTS_CHANGED")
frame:RegisterEvent("OWNED_AUCTIONS_UPDATED")
frame:RegisterEvent("MAIL_SHOW")
frame:RegisterEvent("MAIL_INBOX_UPDATE")

frame:SetScript("OnEvent", function(_, event)
  if event == "BANKFRAME_OPENED" then
    bankOpen = true
    bankObserved = true
    Estate.markDirty()
    return
  end
  if event == "MAIL_INBOX_UPDATE" then
    -- MAIL_SHOW fires before the inbox has loaded; only the update proves
    -- the message list was actually read.
    mailObserved = true
    Estate.markDirty()
    return
  end
  if event == "MAIL_SHOW" then
    Estate.markDirty()
    return
  end
  if event == "OWNED_AUCTIONS_UPDATED" then
    ownedObserved = true
    Estate.markDirty()
    return
  end
  if event == "BANKFRAME_CLOSED" then
    -- Keep the last observed contents; the client no longer promises them.
    bankOpen = false
    Estate.markDirty()
    return
  end
  if event == "PLAYER_ENTERING_WORLD" then
    -- A loading screen closes any bank frame without a CLOSED event.
    bankOpen = false
    Estate.markDirty()
    return
  end
  Estate.markDirty()
end)

-- Build once at load so the first plan has a state even before an event.
Estate.refresh(true)

WAH.Estate = Estate
