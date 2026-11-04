-- Position ledger: a projection of Journal.lua, never an authority.
--
-- Replaying the journal from the first event yields lots, positions,
-- open postings, realized P&L and the capital block. Deleting the ledger
-- costs nothing; deleting the journal loses the only record of what the
-- player actually did.
--
-- Accounting rules:
--   * a buy or craft adds a lot at its unit cost;
--   * a sale consumes lots first-in-first-out and realizes
--     revenue - fee - consumed cost;
--   * a posting does not consume the goods (they are still owned) and
--     moves its deposit into escrow;
--   * a sale refunds the deposit; a cancellation refunds it; an expiry
--     loses it. A deposit is never charged twice.

local ADDON_NAME, WAH = ...

local Ledger = {}
Ledger.VERSION = 1

local function round(value) return math.floor((value or 0) + 0.5) end

local function newState(market)
  return {
    v = Ledger.VERSION,
    market = market,
    lots = {}, -- [itemId] = { { qty, unitCost, at }, ... } oldest first
    positions = {}, -- [itemId] = { qty, cost }
    openPosts = {}, -- [auctionID] = { itemId, qty, price, deposit }
    trades = {}, -- realized sales
    capital = {
      cash = 0,
      escrow = 0,
      mail = 0, -- not observable without a mailbox; always 0 today
      realized = 0,
      fees = 0,
      depositsLost = 0
    },
    errors = {}
  }
end

local function addLot(state, itemId, quantity, unitCost, at)
  if not itemId or quantity <= 0 then return end
  local lots = state.lots[itemId]
  if not lots then
    lots = {}
    state.lots[itemId] = lots
  end
  lots[#lots + 1] = { qty = quantity, unitCost = unitCost or 0, at = at }
end

-- FIFO consumption. Returns the cost basis of the consumed units and the
-- quantity actually consumed. A sale larger than the booked position can
-- happen when the journal starts mid-history (the addon was installed
-- after the purchase); the shortfall is consumed at zero basis and
-- recorded, not hidden.
local function consume(state, itemId, quantity, at)
  local lots = state.lots[itemId]
  local remaining = quantity or 0
  local basis = 0
  local consumed = 0
  if lots then
    while remaining > 0 and #lots > 0 do
      local lot = lots[1]
      local take = math.min(remaining, lot.qty)
      basis = basis + take * lot.unitCost
      lot.qty = lot.qty - take
      remaining = remaining - take
      consumed = consumed + take
      if lot.qty <= 0 then table.remove(lots, 1) end
    end
    if #lots == 0 then state.lots[itemId] = nil end
  end
  if remaining > 0 then
    state.errors[#state.errors + 1] = {
      t = at,
      kind = "short_position",
      itemId = itemId,
      missing = remaining
    }
  end
  return basis, consumed
end

local function totalCost(lots)
  local cost = 0
  for _, lot in ipairs(lots or {}) do cost = cost + lot.qty * lot.unitCost end
  return cost
end

local function postKey(event, index)
  return event.auctionID or ("event:" .. tostring(index))
end

-- Pure replay. `events` is the journal array; `market` labels the result.
function Ledger.replay(events, market)
  local state = newState(market)
  local posts = state.openPosts
  for index, event in ipairs(events or {}) do
    local kind = event.k
    if kind == "buy" then
      local quantity = event.qty or 0
      local cost = event.cost or 0
      addLot(state, event.itemId, quantity, quantity > 0 and cost / quantity or 0, event.t)
    elseif kind == "craft" then
      local quantity = event.qty or 0
      local cost = event.cost or 0
      addLot(state, event.itemId, quantity, quantity > 0 and cost / quantity or 0, event.t)
    elseif kind == "vendor" then
      local basis = consume(state, event.itemId, event.qty or 0, event.t)
      state.capital.realized = state.capital.realized + (event.paid or 0) - basis
      state.trades[#state.trades + 1] = {
        t = event.t, itemId = event.itemId, qty = event.qty or 0,
        price = (event.qty or 0) > 0 and ((event.paid or 0) / event.qty) or 0,
        fee = 0, basis = basis, pnl = (event.paid or 0) - basis, channel = "vendor"
      }
    elseif kind == "post" then
      local key = postKey(event, index)
      posts[key] = {
        itemId = event.itemId,
        qty = event.qty or 0,
        price = event.price or 0,
        deposit = event.deposit or 0,
        at = event.t,
        duration = event.duration
      }
      state.capital.escrow = state.capital.escrow + (event.deposit or 0)
    elseif kind == "sold" then
      local key = postKey(event, index)
      local post = posts[key]
      local quantity = event.qty or (post and post.qty) or 0
      local price = event.price or (post and post.price) or 0
      local fee = event.fee or 0
      local basis = consume(state, event.itemId or (post and post.itemId), quantity, event.t)
      state.capital.realized = state.capital.realized + price * quantity - fee - basis
      state.capital.fees = state.capital.fees + fee
      if post then
        state.capital.escrow = state.capital.escrow - post.deposit
        posts[key] = nil
      end
      state.trades[#state.trades + 1] = {
        t = event.t, itemId = event.itemId or (post and post.itemId), qty = quantity,
        price = price, fee = fee, basis = basis,
        pnl = price * quantity - fee - basis, channel = "auction"
      }
    elseif kind == "cancel" then
      local key = postKey(event, index)
      local post = posts[key]
      local lost = event.lostDeposit or 0
      local refund = event.refund or ((post and post.deposit or 0) - lost)
      state.capital.escrow = math.max(0, state.capital.escrow - refund - lost)
      state.capital.depositsLost = state.capital.depositsLost + lost
      posts[key] = nil
    elseif kind == "expire" then
      local key = postKey(event, index)
      local post = posts[key]
      local lost = event.lostDeposit or (post and post.deposit) or 0
      state.capital.escrow = math.max(0, state.capital.escrow - lost)
      state.capital.depositsLost = state.capital.depositsLost + lost
      posts[key] = nil
    elseif kind == "de" or kind == "prospect" or kind == "mill" then
      local basis = consume(state, event.itemId, event.qty or 0, event.t)
      local outputs = event.outputs or {}
      local outputQty = 0
      for _, output in ipairs(outputs) do outputQty = outputQty + (output.qty or 0) end
      local unitCost = outputQty > 0 and basis / outputQty or 0
      for _, output in ipairs(outputs) do
        addLot(state, output.itemId, output.qty or 0, unitCost, event.t)
      end
    else
      state.errors[#state.errors + 1] = { t = event.t, kind = "unknown_event", name = tostring(kind) }
    end
  end
  for itemId, lots in pairs(state.lots) do
    local quantity, cost = 0, totalCost(lots)
    for _, lot in ipairs(lots) do quantity = quantity + lot.qty end
    if quantity <= 0 then
      state.lots[itemId] = nil
    else
      state.positions[itemId] = { qty = quantity, cost = round(cost) }
    end
  end
  state.capital.realized = round(state.capital.realized)
  state.capital.fees = round(state.capital.fees)
  state.capital.depositsLost = round(state.capital.depositsLost)
  state.capital.escrow = round(state.capital.escrow)
  return state
end

function Ledger.rebuild()
  local events = WAH.Journal and WAH.Journal.current() or {}
  local market = WAH.Journal and WAH.Journal.bookKey() or "local"
  local state = Ledger.replay(events, market)
  state.capital.cash = GetMoney and GetMoney() or 0
  WoWderhoiAH_Ledger = state
  return state
end

function Ledger.current()
  local ledger = WoWderhoiAH_Ledger
  local market = WAH.Journal and WAH.Journal.bookKey() or "local"
  if not ledger or ledger.v ~= Ledger.VERSION or ledger.market ~= market then
    return Ledger.rebuild()
  end
  return ledger
end

function Ledger.positions()
  return Ledger.current().positions
end

function Ledger.capital()
  return Ledger.current().capital
end

-- Deployable capital: cash plus coins already earned but still in the
-- mailbox (not observable today, so zero) minus nothing. Escrow is not
-- spendable while a listing is live.
function Ledger.deployable()
  local capital = Ledger.capital()
  return math.max(0, (capital.cash or 0) + (capital.mail or 0))
end

WAH.Ledger = Ledger
