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
-- Version 5: every trade states whether the ledger could price the units it
-- consumed. A sale larger than the booked history realizes revenue with an
-- unknown basis; reporting that as profit is a windfall, not a result.
-- Version 4 added the stable sequence and the prefix checkpoint; version 3
-- the auctionID on trades; version 2 the material FIFO craft cost, partial
-- fills and listing-time exposure.
Ledger.VERSION = 5

local function round(value) return math.floor((value or 0) + 0.5) end

local function newState(market)
  return {
    v = Ledger.VERSION,
    market = market,
    lots = {}, -- [itemId] = { { qty, unitCost, at }, ... } oldest first
    positions = {}, -- [itemId] = { qty, cost }
    openPosts = {}, -- [auctionID] = { itemId, qty, price, deposit }
    trades = {}, -- realized sales
    -- Cash is not part of the ledger: GetMoney() is the only live source,
    -- and a snapshot taken at the last rebuild would go stale the moment the
    -- player loots or pays. `cashDelta` is the change these events can
    -- prove; `cashAnchor` is the purse when the book was created. Their sum
    -- is the expected purse, and the reconciler reports the difference.
    capital = {
      escrow = 0,
      realized = 0,
      fees = 0,
      depositsLost = 0,
      cashDelta = 0
    },
    cashAnchor = nil,
    errors = {}
  }
end

local function copyState(initial, market)
  local state = newState(market)
  if not initial then return state end
  for itemId, lots in pairs(initial.lots or {}) do
    local copy = {}
    for index, lot in ipairs(lots) do
      copy[index] = {
        qty = lot.qty,
        unitCost = lot.unitCost,
        at = lot.at,
        known = lot.known
      }
    end
    state.lots[itemId] = copy
  end
  for key, post in pairs(initial.openPosts or {}) do
    state.openPosts[key] = {
      itemId = post.itemId,
      qty = post.qty,
      price = post.price,
      deposit = post.deposit,
      at = post.at
    }
  end
  for index, trade in ipairs(initial.trades or {}) do
    local copy = {}
    for field, value in pairs(trade) do copy[field] = value end
    state.trades[index] = copy
  end
  local capital = initial.capital or {}
  state.capital = {
    escrow = capital.escrow or 0,
    realized = capital.realized or 0,
    fees = capital.fees or 0,
    depositsLost = capital.depositsLost or 0,
    cashDelta = capital.cashDelta or 0
  }
  state.cashAnchor = initial.cashAnchor
  return state
end

local function addLot(state, itemId, quantity, unitCost, at, known)
  if not itemId or quantity <= 0 then return end
  local lots = state.lots[itemId]
  if not lots then
    lots = {}
    state.lots[itemId] = lots
  end
  lots[#lots + 1] = {
    qty = quantity,
    unitCost = unitCost or 0,
    at = at,
    known = known ~= false
  }
end

-- FIFO consumption. Returns the cost basis of the consumed units and
-- whether the ledger could price all of them. A sale larger than the booked
-- position can happen when the journal starts mid-history (the addon was
-- installed after the purchase); the shortfall is consumed at zero basis and
-- recorded, not hidden, and any trade built from it is labelled unknown.
local function consume(state, itemId, quantity, at)
  local lots = state.lots[itemId]
  local remaining = quantity or 0
  local basis = 0
  local known = itemId ~= nil
  if lots then
    while remaining > 0 and #lots > 0 do
      local lot = lots[1]
      local take = math.min(remaining, lot.qty)
      basis = basis + take * lot.unitCost
      if lot.known == false then known = false end
      lot.qty = lot.qty - take
      remaining = remaining - take
      if lot.qty <= 0 then table.remove(lots, 1) end
    end
    if #lots == 0 then state.lots[itemId] = nil end
  end
  if remaining > 0 then
    known = false
    state.errors[#state.errors + 1] = {
      t = at,
      kind = "short_position",
      itemId = itemId,
      missing = remaining
    }
  end
  return basis, known
end

local function totalCost(lots)
  local cost = 0
  for _, lot in ipairs(lots or {}) do cost = cost + lot.qty * lot.unitCost end
  return cost
end

local function postKey(event, index)
  return event.auctionID or ("event:" .. tostring(index))
end

-- Pure replay. `events` is the journal array; `market` labels the result;
-- `initial` is a checkpoint state (lots, openPosts, trades, capital,
-- cashAnchor) the surviving events apply on top of.
function Ledger.replay(events, market, initial)
  local state = copyState(initial, market)
  local posts = state.openPosts
  for index, event in ipairs(events or {}) do
    local kind = event.k
    if kind == "buy" then
      local quantity = event.qty or 0
      local cost = event.cost or 0
      -- An estimate from the current search results is not a receipt. The
      -- lot carries it so positions can be valued, but a later sale must
      -- report its profit as unknown rather than exact.
      local known = event.priceSource ~= "estimated"
      addLot(state, event.itemId, quantity, quantity > 0 and cost / quantity or 0, event.t, known)
      state.capital.cashDelta = state.capital.cashDelta - cost
    elseif kind == "craft" then
      -- A craft consumes its materials and adds the product at their FIFO
      -- cost. The capture side never prices the craft: the ledger is the
      -- only authority for what the consumed units were booked at.
      local basis = 0
      local known = true
      for _, material in ipairs(event.mats or {}) do
        local materialBasis, materialKnown = consume(state, material.itemId, material.qty or 0, event.t)
        basis = basis + materialBasis
        known = known and materialKnown
      end
      local quantity = event.qty or 0
      addLot(state, event.itemId, quantity, quantity > 0 and basis / quantity or 0, event.t, known)
    elseif kind == "vendor" then
      local basis, known = consume(state, event.itemId, event.qty or 0, event.t)
      state.capital.realized = state.capital.realized + (event.paid or 0) - basis
      state.capital.cashDelta = state.capital.cashDelta + (event.paid or 0)
      -- Money is whole copper. A unit price can be fractional (a stack
      -- bought or sold as a lot), but the trade rows must survive an
      -- integer-column projection: round the unit price and the realized
      -- cash once, here, and identically on both runtimes.
      state.trades[#state.trades + 1] = {
        t = event.t, seq = event.seq, itemId = event.itemId, qty = event.qty or 0,
        price = (event.qty or 0) > 0 and round((event.paid or 0) / event.qty) or 0,
        fee = 0, basis = basis, basisKnown = known,
        pnl = round((event.paid or 0) - basis), channel = "vendor",
        inferred = false, observedAt = event.t, censored = false
      }
    elseif kind == "post" then
      local key = postKey(event, index)
      posts[key] = {
        itemId = event.itemId,
        qty = event.qty or 0,
        price = event.price or 0,
        deposit = event.deposit or 0,
        at = event.t
      }
      state.capital.escrow = state.capital.escrow + (event.deposit or 0)
      state.capital.cashDelta = state.capital.cashDelta - (event.deposit or 0)
    elseif kind == "sold" then
      local key = postKey(event, index)
      local post = posts[key]
      local quantity = event.qty or (post and post.qty) or 0
      local price = event.price or (post and post.price) or 0
      local fee = event.fee or 0
      local itemId = event.itemId or (post and post.itemId)
      local basis, known = consume(state, itemId, quantity, event.t)
      state.capital.realized = state.capital.realized + price * quantity - fee - basis
      state.capital.fees = state.capital.fees + fee
      state.capital.cashDelta = state.capital.cashDelta + price * quantity - fee
      if post then
        -- A commodity listing can fill in pieces: keep the remaining units
        -- open and refund the deposit only when the posting is exhausted.
        local remaining = (post.qty or 0) - quantity
        if remaining > 0 then
          post.qty = remaining
        else
          state.capital.escrow = state.capital.escrow - post.deposit
          state.capital.cashDelta = state.capital.cashDelta + post.deposit
          posts[key] = nil
        end
      end
      state.trades[#state.trades + 1] = {
        t = event.t, seq = event.seq, itemId = itemId, qty = quantity,
        price = round(price), fee = round(fee), basis = basis, basisKnown = known,
        pnl = round(price * quantity - fee - basis), channel = "auction",
        auctionID = event.auctionID,
        inferred = event.inferred == true,
        listedAt = event.listedAt or (post and post.at),
        observedAt = event.t,
        censored = event.censored == true
      }
    elseif kind == "confirm" then
      -- The mailbox confirmed a sale an older addon version had booked as
      -- an inference. Upgrade that trade in place: booking the
      -- sale again would count the revenue and the consumed lots twice.
      local trade
      for _, candidate in ipairs(state.trades) do
        if candidate.inferred and candidate.channel == "auction"
          and event.auctionID ~= nil and candidate.auctionID == event.auctionID then
          trade = candidate
          break
        end
      end
      if trade then
        local quantity = event.qty or trade.qty
        local price = event.price or trade.price
        local fee = event.fee or trade.fee
        state.capital.realized = state.capital.realized
          + (price * quantity - fee) - (trade.price * trade.qty - trade.fee)
        state.capital.fees = state.capital.fees + fee - trade.fee
        state.capital.cashDelta = state.capital.cashDelta
          + (price * quantity - fee) - (trade.price * trade.qty - trade.fee)
        trade.qty, trade.price, trade.fee = quantity, round(price), round(fee)
        trade.pnl = round(price * quantity - fee - trade.basis)
        trade.inferred = false
        trade.listedAt = event.listedAt or trade.listedAt
        trade.observedAt = event.t
        trade.censored = event.censored == true
      else
        -- Only a truncated journal should get here; report it rather than
        -- booking a sale whose lots were never consumed.
        state.errors[#state.errors + 1] = {
          t = event.t, kind = "confirm_without_sale", itemId = event.itemId
        }
      end
    elseif kind == "cancel" then
      local key = postKey(event, index)
      local post = posts[key]
      local lost = event.lostDeposit or 0
      local refund = event.refund or ((post and post.deposit or 0) - lost)
      state.capital.escrow = math.max(0, state.capital.escrow - refund - lost)
      state.capital.depositsLost = state.capital.depositsLost + lost
      state.capital.cashDelta = state.capital.cashDelta + refund
      posts[key] = nil
    elseif kind == "expire" then
      local key = postKey(event, index)
      local post = posts[key]
      local lost = event.lostDeposit or (post and post.deposit) or 0
      state.capital.escrow = math.max(0, state.capital.escrow - lost)
      state.capital.depositsLost = state.capital.depositsLost + lost
      posts[key] = nil
    elseif kind == "transfer_out" then
      -- Goods moved to another character. The journal keeps the FIFO cost
      -- the sending book carried, so the receiving book can add the same
      -- basis instead of inventing a zero-cost lot.
      consume(state, event.itemId, event.qty or 0, event.t)
    elseif kind == "transfer_in" then
      local quantity = event.qty or 0
      -- The sender prints the cost; a missing cost is unknown, not zero.
      addLot(state, event.itemId, quantity,
        quantity > 0 and (event.cost or 0) / quantity or 0, event.t, event.cost ~= nil)
    elseif kind == "de" or kind == "prospect" or kind == "mill" then
      local basis, known = consume(state, event.itemId, event.qty or 0, event.t)
      local outputs = event.outputs or {}
      local outputQty = 0
      for _, output in ipairs(outputs) do outputQty = outputQty + (output.qty or 0) end
      local unitCost = outputQty > 0 and basis / outputQty or 0
      for _, output in ipairs(outputs) do
        addLot(state, output.itemId, output.qty or 0, unitCost, event.t, known)
      end
    elseif kind == "bid" then
      -- A bid freezes money but does not consume goods. The win arrives as
      -- a mail `buy`, which is the cash fact; counting the freeze here too
      -- would subtract the same copper twice.
    elseif kind == "adopt" then
      -- An annotation, not a trade: the terminal reads it to attribute a
      -- later sale, and the ledger has no state to change.
    else
      state.errors[#state.errors + 1] = { t = event.t, kind = "unknown_event", name = tostring(kind) }
    end
  end
  for itemId, lots in pairs(state.lots) do
    local quantity, cost = 0, totalCost(lots)
    local known = true
    for _, lot in ipairs(lots) do
      quantity = quantity + lot.qty
      if lot.known == false then known = false end
    end
    if quantity <= 0 then
      state.lots[itemId] = nil
    else
      state.positions[itemId] = { qty = quantity, cost = round(cost), costKnown = known }
    end
  end
  state.capital.realized = round(state.capital.realized)
  state.capital.fees = round(state.capital.fees)
  state.capital.depositsLost = round(state.capital.depositsLost)
  state.capital.escrow = round(state.capital.escrow)
  state.capital.cashDelta = round(state.capital.cashDelta)
  return state
end

-- The checkpoint form of a replay state. It keeps the FIFO lots, the open
-- postings, the recent trades the fill model reads, the capital block and
-- the cash anchor; the terminal can replay it without the removed events.
function Ledger.snapshot(state)
  local trades = {}
  local cutoff = time() - 7 * 24 * 3600
  for _, trade in ipairs(state.trades or {}) do
    if (trade.t or 0) >= cutoff then
      local copy = {}
      for field, value in pairs(trade) do copy[field] = value end
      trades[#trades + 1] = copy
    end
  end
  return {
    lots = state.lots,
    openPosts = state.openPosts,
    trades = trades,
    capital = state.capital,
    cashAnchor = state.cashAnchor
  }
end

function Ledger.rebuild()
  local book = WAH.Journal and WAH.Journal.book() or nil
  local events = book and book.e or {}
  local market = WAH.Journal and WAH.Journal.bookKey() or "local"
  local state = Ledger.replay(events, market, book and book.checkpoint and book.checkpoint.state)
  state.cashAnchor = state.cashAnchor
    or (book and book.checkpoint and book.checkpoint.state and book.checkpoint.state.cashAnchor)
    or (book and book.cashAnchor)
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

-- Units the player bought inside [from, to], per item. The scan's flow
-- inference reads this: a unit that vanished because the player bought it
-- is the player's own demand, not evidence about the market. The journal is
-- the only place a purchase is a fact, so this is the only authority.
function Ledger.purchasesBetween(from, to)
  local events = WAH.Journal and WAH.Journal.current() or {}
  local byItem = {}
  for _, event in ipairs(events) do
    local at = event.t or 0
    if event.k == "buy" and at >= (from or 0) and at <= (to or 0) then
      byItem[event.itemId] = (byItem[event.itemId] or 0) + (event.qty or 0)
    end
  end
  return byItem
end

-- Auction sales per item inside a window. These are the only clean fill
-- labels the decision core ever receives: a collected sale is a fact, a
-- public disappearance is an inference. Inferred trades are excluded.
--
-- Exposure hours are per sale, not first-to-last: each listing was on the
-- book for the time between posting and the sale being observed, and a
-- mailbox sale is observed when the player opens the mailbox (censored).
-- Summing those windows gives units per exposed hour, which is what the
-- queue model needs; a first-to-last span understates exposure whenever
-- several listings sold close together.
function Ledger.salesSince(windowSeconds, nowTs)
  local state = Ledger.current()
  local defaultDays = (WAH.RULES and WAH.RULES.fill and WAH.RULES.fill.ownSalesWindowDays) or 7
  local window = windowSeconds or defaultDays * 24 * 3600
  local cutoff = (nowTs or time()) - window
  local scanFloorHours = (WAH.RULES and WAH.RULES.scanIntervalMinutes or 15) / 60
  local scanFloor = scanFloorHours * 3600
  local byItem = {}
  for _, trade in ipairs(state.trades or {}) do
    local quantity = trade.qty or 0
    if trade.itemId and trade.t >= cutoff and trade.channel == "auction"
      and not trade.inferred and quantity > 0 then
      local record = byItem[trade.itemId]
      if not record then
        record = { qty = 0, samples = 0, exposed = 0 }
        byItem[trade.itemId] = record
      end
      record.qty = record.qty + quantity
      record.samples = record.samples + 1
      local observedAt = trade.observedAt or trade.t
      local listedAt = trade.listedAt or (observedAt - scanFloor)
      -- The window bounds which sales count, not how long a sale waited:
      -- a listing that sat for a week belongs in its exposure.
      record.exposed = record.exposed + math.max(observedAt - listedAt, scanFloor)
    end
  end
  for _, record in pairs(byItem) do
    record.exposedHours = math.max(record.exposed / 3600, scanFloorHours)
  end
  return byItem
end

WAH.Ledger = Ledger
