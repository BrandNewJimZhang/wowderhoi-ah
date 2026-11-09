-- Reconciliation between what the ledger can prove and what the client
-- currently shows. It runs in the addon because only the addon holds the
-- live estate, the ledger and the owned list at the same moment; the
-- terminal sees one snapshot and cannot tell "this item is absent" from
-- "this location was never observed".
--
-- The output is a per-item holding:
--   knownQty   units the ledger can price (FIFO basis)
--   unknownQty units the estate shows but the ledger never booked (loot,
--              mail, pre-install stock); their cost is unknown, not zero
--   missingQty units the ledger booked that the observed locations do not
--              show; zero while any relevant location is unobserved
-- and a cash block comparing GetMoney with the anchor plus the cash delta
-- the journal can prove.

local ADDON_NAME, WAH = ...

local Reconciler = {}

local function round(value) return math.floor((value or 0) + 0.5) end

local function observed(scope, key)
  return scope and scope.coverage and scope.coverage[key] == "observed"
end

local function quantityAt(scope, itemId, location)
  local byLocation = scope and scope.items and scope.items[itemId]
  local entry = byLocation and byLocation[location]
  return entry and entry.qty or 0
end

-- Build the reconciliation for one estate snapshot. It is pure: the caller
-- owns the snapshot, so Estate and the journal writer can both ask for the
-- same result without recursing through Estate.snapshot().
function Reconciler.run(snapshot)
  local character = snapshot and snapshot.scopes and snapshot.scopes[WAH.Estate.characterKey()]
  local account = snapshot and snapshot.scopes and snapshot.scopes.account
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  local positions = ledger and ledger.positions or {}

  local bankObserved = observed(character, "bank")
  local mailObserved = observed(character, "mail")
  local accountBankObserved = observed(account, "account_bank")
  local listedObserved = observed(account, "listed")
  local allObserved = bankObserved and mailObserved and accountBankObserved and listedObserved

  local itemIds = {}
  for itemId in pairs(positions) do itemIds[itemId] = true end
  for itemId in pairs(character and character.items or {}) do itemIds[itemId] = true end
  for itemId in pairs(account and account.items or {}) do itemIds[itemId] = true end

  local items = {}
  for itemId in pairs(itemIds) do
    local position = positions[itemId]
    local ledgerQty = position and position.qty or 0
    local costBasis = position and position.cost or 0
    local carried = quantityAt(character, itemId, "carried")
    local keyring = quantityAt(character, itemId, "keyring")
    local bank = bankObserved and quantityAt(character, itemId, "bank") or 0
    local accountBank = accountBankObserved and quantityAt(account, itemId, "account_bank") or 0
    local mail = mailObserved and quantityAt(character, itemId, "mail") or 0
    local listed = listedObserved and quantityAt(account, itemId, "listed") or 0
    local totalQty = carried + keyring + bank + accountBank + mail + listed
    local knownQty = math.min(ledgerQty, totalQty)
    local unknownQty = math.max(0, totalQty - ledgerQty)
    local missingQty = allObserved and math.max(0, ledgerQty - totalQty) or 0
    items[itemId] = {
      itemId = itemId,
      ledgerQty = ledgerQty,
      totalQty = totalQty,
      carriedQty = carried,
      keyringQty = keyring,
      bankQty = bank,
      accountBankQty = accountBank,
      mailQty = mail,
      listedQty = listed,
      knownQty = knownQty,
      unknownQty = unknownQty,
      missingQty = missingQty,
      missingUnobserved = (not allObserved) and ledgerQty > totalQty or false,
      costBasis = costBasis,
      unitCost = ledgerQty > 0 and costBasis / ledgerQty or 0,
      sellableQty = carried,
      requiresBank = (bank + accountBank) > 0 and carried == 0,
      coverage = {
        bank = bankObserved and "observed" or "unobserved",
        accountBank = accountBankObserved and "observed" or "unobserved",
        mail = mailObserved and "observed" or "unobserved",
        listed = listedObserved and "observed" or "unobserved"
      }
    }
  end

  -- The book anchor is the authority; a cached ledger can still carry the
  -- anchor it was rebuilt with after the book was migrated.
  local book = WAH.Journal and WAH.Journal.book() or nil
  -- The book is the authority even when its anchor is nil: a migrated v1
  -- book has no anchor, and a cached ledger must not invent one.
  local anchor = book and book.cashAnchor or nil
  if not book and ledger then anchor = ledger.cashAnchor end
  local cash = {
    anchor = anchor,
    delta = ledger and ledger.capital and ledger.capital.cashDelta or 0,
    actual = GetMoney and GetMoney() or 0
  }
  if cash.anchor then
    cash.expected = cash.anchor + cash.delta
    cash.unexplained = cash.actual - cash.expected
  else
    cash.expected = nil
    cash.unexplained = nil
  end
  cash.coverage = cash.anchor and "observed" or "unobserved"

  return {
    v = 1,
    at = time(),
    items = items,
    cash = cash,
    coverage = {
      bank = bankObserved and "observed" or "unobserved",
      accountBank = accountBankObserved and "observed" or "unobserved",
      mail = mailObserved and "observed" or "unobserved",
      listed = listedObserved and "observed" or "unobserved"
    }
  }
end

-- Attach the result to the current estate snapshot without rebuilding the
-- containers. Journal writes call this: the estate did not move, but what
-- the ledger can prove did.
function Reconciler.publish()
  local snapshot = WoWderhoiAH_Estate
  if not snapshot then return nil end
  snapshot.reconciled = Reconciler.run(snapshot)
  return snapshot.reconciled
end

function Reconciler.current()
  local snapshot = WoWderhoiAH_Estate
  if not snapshot then return nil end
  return snapshot.reconciled or Reconciler.publish()
end

function Reconciler.item(itemId)
  local result = Reconciler.current()
  return result and result.items[itemId] or nil
end

function Reconciler.diagnostics()
  local result = Reconciler.current()
  if not result then return { "reconcile: no estate snapshot" } end
  local missing, unknown, unobserved, count = 0, 0, 0, 0
  for _, item in pairs(result.items) do
    count = count + 1
    missing = missing + item.missingQty
    unknown = unknown + item.unknownQty
    if item.missingUnobserved then unobserved = unobserved + 1 end
  end
  local cash = result.cash
  return {
    string.format("reconcile: %d items, unknown %d units, missing %d units, %d unobserved gaps",
      count, unknown, missing, unobserved),
    string.format("reconcile: cash anchor %s, delta %d, actual %d, unexplained %s",
      cash.anchor and tostring(cash.anchor) or "none", cash.delta, cash.actual,
      cash.unexplained and tostring(cash.unexplained) or "unknown")
  }
end

-- Keep the state document current at load; later journal writes publish
-- through WAH.recordEvent.
Reconciler.publish()

WAH.Reconciler = Reconciler
