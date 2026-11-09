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
-- Opening the character bank says nothing about the account bank: the tab
-- may not exist on this client, and its containers only report slots once
-- it has been read. Declaring it observed on BANKFRAME_OPENED alone turned
-- "never read" into "genuinely empty".
local accountBankObserved = false
-- Container contents are only promised while the bank is open. The last
-- observed bank is cached so a money or bag event after the bank closes
-- cannot turn the cache into an empty bank.
local bankCache = nil
local mailObserved = false
-- The inbox is only readable while the mailbox is open. Keep the last
-- observed mail so a bag or money event after closing cannot replace it
-- with an empty list.
local mailCache = nil
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
  local accountRead = false
  if C_Container and C_Container.GetContainerNumSlots then
    for bag = ACCOUNT_BANK_FIRST, ACCOUNT_BANK_LAST do
      -- Only a container with slots proves the account bank was actually
      -- read; an absent tab reports zero and must stay `unobserved`.
      if (C_Container.GetContainerNumSlots(bag) or 0) > 0 then
        accountBankObserved = true
        accountRead = true
      end
      scanContainer(fresh, bag, "account_bank")
    end
  end
  -- A visit where no account-bank container reports slots is an unread tab,
  -- not an emptied one: keep the last observation instead of dropping the
  -- stock while coverage still says observed.
  if not accountRead then
    for itemId, byLocation in pairs(bankCache or {}) do
      local entry = byLocation.account_bank
      if entry then addItem(fresh, itemId, "account_bank", entry.qty, entry.slots) end
    end
  end
  bankCache = fresh
  copyBankCache(items)
end

local function copyMailCache(items)
  for itemId, byLocation in pairs(mailCache and mailCache.items or {}) do
    local entry = byLocation.mail
    if entry then addItem(items, itemId, "mail", entry.qty, entry.slots) end
  end
end

-- Mail permits at most twelve attachments; the loop stops at the first
-- empty slot, so this is only a hard bound.
local MAX_ATTACHMENTS = 12

-- One attachment slot. GetInboxItem carries the stack count; the link is
-- the fallback for builds that only expose it. Nil means the slot is empty,
-- which is how the caller knows where the contiguous list ends.
local function readAttachment(message, slot)
  if type(GetInboxItem) == "function" then
    local okItem, _, itemId, _, stack = pcall(GetInboxItem, message, slot)
    if okItem and itemId then return itemId, stack or 1 end
  end
  if type(GetInboxItemLink) == "function" then
    local okLink, link = pcall(GetInboxItemLink, message, slot)
    if okLink and link then
      local itemId = tonumber(tostring(link):match("item:(%d+)"))
      if itemId then return itemId, 1 end
    end
  end
  return nil
end

local function readInbox()
  local fresh = {}
  local pendingCash = 0
  local ok, count = pcall(GetInboxNumItems)
  if not ok or not count then return nil end
  for message = 1, count do
    local okHeader, header = pcall(function() return { GetInboxHeaderInfo(message) } end)
    if okHeader and header then
      pendingCash = pendingCash + (header[5] or 0)
      -- A COD attachment is not owned until it is paid; counting it would
      -- put someone else's goods in the player's holdings.
      local cod = header[6] or 0
      if cod <= 0 then
        -- The header's trailing return is not documented for this client;
        -- probing the slots is the only contract that holds whether it is a
        -- count or a flag.
        for slot = 1, MAX_ATTACHMENTS do
          local itemId, stack = readAttachment(message, slot)
          if not itemId then break end
          addItem(fresh, itemId, "mail", stack, 1)
        end
      end
    end
  end
  return { items = fresh, pendingCash = pendingCash, count = count }
end

local function scanMail(items)
  if not mailObserved then return nil, nil end
  -- GetInboxItem is the preferred source; the link is only the fallback.
  -- Requiring the link would skip every build that exposes the item call.
  if not (GetInboxNumItems and GetInboxHeaderInfo) then return nil, nil end
  -- The client only promises the inbox while the mailbox is open. Closing
  -- it must not turn the cached mail into an empty inbox.
  local open = not (MailFrame and MailFrame.IsShown) or MailFrame:IsShown()
  if open then
    local read = readInbox()
    if read then mailCache = read end
  end
  if not mailCache then return nil, nil end
  copyMailCache(items)
  return mailCache.pendingCash, mailCache.count
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
        cash = GetMoney and GetMoney() or 0,
        -- One free-slot rule for the scan, the radar and the estate.
        freeSlots = WAH.freeBagSlots(),
        -- An unopened mailbox is not an empty one: nil keeps the "never
        -- observed" state distinct from a genuinely zero pending balance.
        pendingCash = mailCount ~= nil and pendingCash or nil,
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
        coverage = {
          account_bank = coverage(accountBankObserved),
          listed = coverage(ownedObserved)
        },
        items = accountItems
      }
    }
  }
  -- Reconciliation is derived from the snapshot and the ledger. Attaching
  -- it here lets the in-game reader use the summary without rebuilding the
  -- containers; Estate.same ignores it so a ledger-only change does not
  -- move the estate revision. The terminal recomputes `Holding` from the
  -- same inputs and does not read this block.
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

function Estate.currentCharacterScope()
  local snapshot = Estate.snapshot()
  return snapshot and snapshot.scopes and snapshot.scopes[characterScope()] or nil
end

function Estate.characterKey()
  return characterScope()
end

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
