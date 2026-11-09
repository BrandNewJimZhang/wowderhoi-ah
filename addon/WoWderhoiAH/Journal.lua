-- Append-only action journal. The market scan says what is listed; the
-- journal says what the player did. It is the only clean label the addon
-- ever gets: public auction data never reveals a sale, but a purchase, a
-- posting, a cancellation, a won bid and a collected sale are facts.
--
-- The journal is not a projection: Ledger.lua rebuilds positions and P&L
-- from it at any time. Nothing else writes the journal, and events are
-- never rewritten. When the local cap is reached, the oldest prefix is
-- folded into a checkpoint (remaining lots, open postings, capital and the
-- cash anchor) and the events it covered are removed; the checkpoint plus
-- the surviving events must replay to exactly the state the full history
-- produced.

local ADDON_NAME, WAH = ...

local Journal = {}
-- The saved shape has evolved in place, per book: version 2 added the stable
-- sequence, the event/observation time pair and the prefix checkpoint;
-- version 3 adds the book epoch and the content revision, because clearing
-- SavedVariables creates a new book whose sequence restarts at 1. Older
-- books are migrated field by field in `migrate`, so no version number is
-- persisted: an unused global would be a second, drifting authority.
Journal.CAP = 5000
-- How many recent events survive a compaction. The checkpoint carries the
-- state of everything older, so the safe prefix is everything but a small
-- recent tail; keeping 1,000 events means a rebuild still sees the recent
-- actions directly.
Journal.COMPACT_KEEP = 1000

local EVENT_KINDS = {
  buy = true, post = true, cancel = true, sold = true, confirm = true,
  expire = true, bid = true, craft = true, vendor = true, de = true,
  prospect = true, mill = true, transfer_out = true, transfer_in = true,
  adopt = true
}

local function bookKey()
  return (GetRealmName() .. "|" .. (UnitFactionGroup("player") or "Unknown")
    .. "|" .. (UnitName and UnitName("player") or "Unknown"))
end
Journal.bookKey = bookKey

local function migrate(book)
  if type(book.e) ~= "table" then book.e = {} end
  book.dropped = book.dropped or 0
  if type(book.nextSeq) ~= "number" then
    local nextSeq = 1
    for index, event in ipairs(book.e) do
      if type(event.seq) ~= "number" then event.seq = nextSeq end
      nextSeq = math.max(nextSeq, event.seq + 1)
    end
    book.nextSeq = nextSeq
  end
  -- V2 added the content revision. A migrated book starts from the number
  -- of events it already carries, so the token only moves forward.
  if type(book.rev) ~= "number" then book.rev = book.nextSeq - 1 end
  -- V3 added the book epoch. A migrated book belongs to the first
  -- installation; zero is its identity and every re-created book is later.
  if type(book.epoch) ~= "number" then book.epoch = 0 end
end

function Journal.ensure()
  WoWderhoiAH_Journal = WoWderhoiAH_Journal or { books = {} }
  local key = bookKey()
  local book = WoWderhoiAH_Journal.books[key]
  if not book then
    book = {
      e = {}, dropped = 0, nextSeq = 1, rev = 0,
      -- Creation time, not a random id: a re-created book always follows
      -- the one whose SavedVariables were cleared.
      epoch = time(),
      cashAnchor = GetMoney and GetMoney() or nil
    }
    WoWderhoiAH_Journal.books[key] = book
  else
    migrate(book)
  end
  return book
end

-- Materialize this character's book at load, before the first action. The
-- terminal imports every book by character; without the empty global the
-- state payload would omit this character and leave its previous holdings
-- standing.
local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, name)
  if name == ADDON_NAME then Journal.ensure() end
end)

function Journal.current()
  local book = Journal.ensure()
  return book.e, book
end

function Journal.book()
  return Journal.ensure()
end

-- Stable per-book revision. The plan identity reads it; the terminal uses
-- it to tell a re-sent book from a new action without comparing event
-- tables. It moves on an append and on an in-place correction, which keeps
-- the same sequence but changes what the fact says.
function Journal.revision()
  local book = Journal.ensure()
  return book.rev
end

-- Mark the book as changed without appending an event. Actions.upgrade uses
-- this when a later handler fills in the exact cost or deposit of a fact
-- already written.
function Journal.touch()
  local book = Journal.ensure()
  book.rev = (book.rev or 0) + 1
  return book.rev
end

-- Fold the oldest prefix into a checkpoint. Returns true when it compacted.
-- The prefix is replayed with the previous checkpoint as its initial state,
-- so repeated compactions compose instead of losing the older basis.
function Journal.compact(book)
  local target = book or Journal.ensure()
  if #target.e <= Journal.CAP then return false end
  if not (WAH.Ledger and WAH.Ledger.replay and WAH.Ledger.snapshot) then return false end
  local prefix = #target.e - Journal.COMPACT_KEEP
  if prefix <= 0 then return false end
  local events = {}
  for index = 1, prefix do events[index] = target.e[index] end
  local state = WAH.Ledger.replay(events, bookKey(), target.checkpoint and target.checkpoint.state)
  target.checkpoint = {
    throughSeq = events[prefix].seq or prefix,
    state = WAH.Ledger.snapshot(state)
  }
  for _ = 1, prefix do table.remove(target.e, 1) end
  target.dropped = (target.dropped or 0) + prefix
  return true
end

-- Append one event. `t` is stamped here so every caller records the same
-- clock; the caller owns every other field. `observedAt` is when the addon
-- learned the fact (the mailbox can only report a sale later), and
-- `censored` says the two differ.
function Journal.append(event)
  if type(event) ~= "table" then
    error("Journal.append expects an event table, got " .. type(event))
  end
  if not EVENT_KINDS[event.k] then
    error("Journal.append: unknown event kind " .. tostring(event.k))
  end
  local book = Journal.ensure()
  local now = time()
  event.seq = book.nextSeq
  book.nextSeq = book.nextSeq + 1
  book.rev = (book.rev or 0) + 1
  event.t = event.t or now
  event.observedAt = event.observedAt or now
  if event.censored == nil then event.censored = event.observedAt > event.t end
  book.e[#book.e + 1] = event
  if #book.e > Journal.CAP and not Journal.compact(book) then
    while #book.e > Journal.CAP do
      table.remove(book.e, 1)
      book.dropped = (book.dropped or 0) + 1
    end
  end
  return event
end

function Journal.count()
  local events = Journal.current()
  return #events
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
  -- The estate did not move, but what the ledger can prove did. Refresh the
  -- reconciliation before the next save so the terminal sees both halves.
  if WAH.Reconciler and WAH.Reconciler.publish then WAH.Reconciler.publish() end
  -- Every journal write is new ledger state; queue one save so the terminal
  -- sees a buy, a post or a craft without waiting for the next scan.
  if WAH.requestFlush then WAH.requestFlush() end
  return recorded
end

WAH.Journal = Journal
