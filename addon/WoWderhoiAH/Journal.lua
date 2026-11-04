-- Append-only action journal. The market scan says what is listed; the
-- journal says what the player did. It is the only clean label the addon
-- ever gets: public auction data never reveals a sale, but a purchase, a
-- posting, a cancellation and a collected sale are facts.
--
-- The journal is not a projection: Ledger.lua rebuilds positions and P&L
-- from it at any time. Nothing else writes the journal, and events are
-- never rewritten -- only truncated from the oldest end when the local
-- cap is reached, with the dropped count recorded.

local ADDON_NAME, WAH = ...

local Journal = {}
Journal.VERSION = 1
Journal.CAP = 5000

local EVENT_KINDS = {
  buy = true, post = true, cancel = true, sold = true, expire = true,
  craft = true, vendor = true, de = true, prospect = true, mill = true
}

local function bookKey()
  return (GetRealmName() .. "|" .. (UnitFactionGroup("player") or "Unknown")
    .. "|" .. (UnitName and UnitName("player") or "Unknown"))
end
Journal.bookKey = bookKey

function Journal.ensure()
  WoWderhoiAH_Journal = WoWderhoiAH_Journal or { v = Journal.VERSION, books = {} }
  local key = bookKey()
  local book = WoWderhoiAH_Journal.books[key]
  if not book then
    book = { e = {}, dropped = 0, createdAt = time() }
    WoWderhoiAH_Journal.books[key] = book
  end
  return book
end

function Journal.current()
  local book = Journal.ensure()
  return book.e, book
end

-- Append one event. `t` is stamped here so every caller records the same
-- clock; the caller owns every other field.
function Journal.append(event)
  if type(event) ~= "table" then
    error("Journal.append expects an event table, got " .. type(event))
  end
  if not EVENT_KINDS[event.k] then
    error("Journal.append: unknown event kind " .. tostring(event.k))
  end
  local book = Journal.ensure()
  event.t = event.t or time()
  event.m = event.m or bookKey()
  book.e[#book.e + 1] = event
  while #book.e > Journal.CAP do
    table.remove(book.e, 1)
    book.dropped = (book.dropped or 0) + 1
  end
  return event
end

function Journal.count()
  local events = Journal.current()
  return #events
end

function Journal.since(epoch)
  local events = Journal.current()
  local out = {}
  for _, event in ipairs(events) do
    if event.t >= (epoch or 0) then out[#out + 1] = event end
  end
  return out
end

function Journal.last(kind)
  local events = Journal.current()
  for index = #events, 1, -1 do
    if not kind or events[index].k == kind then return events[index] end
  end
  return nil
end

-- Single write path used by every UI: append the fact, then rebuild the
-- projection. Keeping the rebuild here means a new action cannot forget
-- to update the ledger.
function WAH.recordEvent(event)
  local recorded = Journal.append(event)
  if WAH.Ledger then WAH.Ledger.rebuild() end
  return recorded
end

WAH.Journal = Journal
