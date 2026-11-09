-- Mailbox capture: the only clean sale label the client ever exposes.
--
-- A public listing that disappears between two scans may have sold, been
-- cancelled or been repriced; the mailbox is the one place the client says
-- "this auction sold for X, commission Y". This module translates sale and
-- expiry mails into journal events and never guesses: an unattributable
-- mail is counted and left for a later scan, not booked against a random
-- item and not marked as handled.
--
-- The invoice and header calls are classic globals present in the 1.60
-- client but absent from the generated API documentation, so every read is
-- guarded and /wahdiag mail prints the raw returns for a live check.

local ADDON_NAME, WAH = ...

local Mail = {}
local SEEN_CAP = 500

-- The store counts, per fingerprint, how many identical mails have already
-- been booked. A commodity listing that fills in equal pieces produces
-- several mails with the same subject, item and amounts; a set would treat
-- the second one as a duplicate and silently undercount confirmed sales.
-- A count is kept while its mail may still be in the inbox (eviction only
-- drops fingerprints absent from the current visit), so re-reading the same
-- mail never books it twice. The cost of that choice is the opposite
-- direction: an identical mail arriving after the earlier one was deleted
-- is treated as already booked.
local function seenStore()
  local store = WoWderhoiAH_MailSeen
  if type(store) == "table" and store.v == 2 and type(store.counts) == "table" then
    store.order = store.order or {}
    return store
  end
  -- Migrate the v1 set: every recorded fingerprint was booked once. Keeping
  -- the keys is what stops the first scan after the upgrade from booking
  -- the whole inbox a second time.
  local counts = {}
  if type(store) == "table" and type(store.keys) == "table" then
    for fingerprint in pairs(store.keys) do counts[fingerprint] = 1 end
  end
  store = { v = 2, counts = counts, order = {} }
  for fingerprint in pairs(counts) do store.order[#store.order + 1] = fingerprint end
  WoWderhoiAH_MailSeen = store
  return store
end

-- Counts this mail's occurrence in the inbox. Returns true when the count
-- exceeds what is already booked, and therefore should be booked now.
local function firstUnbooked(store, tally, fingerprint)
  tally[fingerprint] = (tally[fingerprint] or 0) + 1
  return tally[fingerprint] > (store.counts[fingerprint] or 0)
end

local function commitTally(store, tally)
  for fingerprint, count in pairs(tally) do
    if count > (store.counts[fingerprint] or 0) then
      if store.counts[fingerprint] == nil then
        store.order[#store.order + 1] = fingerprint
      end
      store.counts[fingerprint] = count
    end
  end
  -- Evict only fingerprints whose mails are no longer in the inbox. A
  -- fingerprint still present this scan is the guard that stops the next
  -- visit from booking the same mail again; dropping it at the cap booked
  -- the sale twice. The inbox holds at most ~50 mails, so with a cap of 500
  -- there is always a departed entry to evict.
  local index = 1
  while #store.order > SEEN_CAP and index <= #store.order do
    local fingerprint = store.order[index]
    if tally[fingerprint] then
      index = index + 1
    else
      table.remove(store.order, index)
      store.counts[fingerprint] = nil
    end
  end
end

local function headerAt(index)
  local header = { GetInboxHeaderInfo(index) }
  -- packageIcon, stationeryIcon, sender, subject, money, CODAmount,
  -- daysLeft, hasItem, wasRead, wasReturned, textCreated, canReply,
  -- numAttachments
  return {
    sender = header[3],
    subject = header[4] or "",
    money = header[5] or 0,
    hasItem = header[8] == true,
    attachments = header[13] or 0
  }
end

local function invoiceAt(index)
  if type(GetInboxInvoiceInfo) ~= "function" then return nil end
  local ok, invoice = pcall(function() return { GetInboxInvoiceInfo(index) } end)
  if not ok or invoice[1] == nil then return nil end
  -- invoiceType, name, player, bid, buyout, deposit, consignment, ...
  return {
    kind = invoice[1],
    name = invoice[2],
    player = invoice[3],
    bid = invoice[4] or 0,
    buyout = invoice[5] or 0,
    deposit = invoice[6] or 0,
    consignment = invoice[7] or 0
  }
end

-- The stack count of the first attachment. A won bid can be a stack, not
-- one unit; booking it as one understates the position it created.
local function attachmentQuantity(index)
  if type(GetInboxItem) ~= "function" then return 1 end
  local ok, _, itemId, _, count = pcall(GetInboxItem, index, 1)
  if ok and itemId and count and count > 0 then return count end
  return 1
end

-- The attachment's item id. GetInboxItem states it directly on modern
-- clients; the link is the fallback for builds that only expose the link.
local function itemFromLink(index)
  for attachment = 1, 8 do
    if type(GetInboxItem) == "function" then
      local ok, _, itemId = pcall(GetInboxItem, index, attachment)
      if ok and itemId then return itemId end
    end
    if type(GetInboxItemLink) == "function" then
      local ok, link = pcall(GetInboxItemLink, index, attachment)
      if ok and link then
        local itemId = tonumber(tostring(link):match("item:(%d+)"))
        if itemId then return itemId end
      end
    end
  end
  return nil
end

-- The invoice type separates a sale from an expiry, a won bid and a
-- cancellation. The client has shipped this field as both a number and a
-- string across builds, so both are mapped here; an unknown value is kept
-- as lower-case text instead of dropped.
local INVOICE_KINDS = {
  [0] = "sold", [1] = "expired", [2] = "won", [3] = "cancelled",
  seller = "sold", sold = "sold",
  expired = "expired", expiry = "expired",
  won = "won", bidder = "won",
  cancelled = "cancelled", canceled = "cancelled", cancel = "cancelled"
}

local function invoiceKind(invoice)
  if not invoice then return nil end
  local kind = invoice.kind
  if type(kind) == "string" then
    local text = kind:lower()
    return INVOICE_KINDS[text] or text
  end
  return INVOICE_KINDS[kind]
end

-- Names are the fallback when the attachment is gone (sold mail carries
-- money, not the goods). The scan's item names and the ids already open in
-- the ledger cover everything the player can plausibly have listed.
local function nameIndex()
  local index = {}
  local scan = WAH.currentScanItems and WAH.currentScanItems() or nil
  for itemId, entry in pairs(scan or {}) do
    if entry.name and #entry.name >= 3 then index[entry.name] = itemId end
  end
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  -- GetItemInfo is the expensive call here, and the journal can hold
  -- thousands of trades naming the same handful of items: resolve each
  -- item once per mailbox visit, not once per trade.
  local resolved = {}
  local function add(itemId)
    if not itemId or resolved[itemId] then return end
    resolved[itemId] = true
    local name = C_Item and C_Item.GetItemInfo and C_Item.GetItemInfo(itemId)
    if name and #name >= 3 then index[name] = itemId end
  end
  for _, post in pairs(ledger and ledger.openPosts or {}) do add(post.itemId) end
  -- Trades matter when the posting is already closed: a sale booked by an
  -- older addon version as an inference removed its post, and the mail that
  -- confirms it can arrive after. Current versions book sales from events.
  for _, trade in ipairs(ledger and ledger.trades or {}) do add(trade.itemId) end
  return index
end

local function itemFromText(texts, index)
  local bestName, bestId = nil, nil
  for name, itemId in pairs(index) do
    for _, text in ipairs(texts) do
      if text and text ~= "" and text:find(name, 1, true) then
        if not bestName or #name > #bestName then bestName, bestId = name, itemId end
      end
    end
  end
  return bestId
end

-- Match an open posting to a mail. The invoice reports the total buyout,
-- so the sold quantity is total / unit price: that also covers commodity
-- partial fills, where one listing produces several sale mails.
local function matchPost(itemId, totalBuyout)
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  local found
  for auctionID, post in pairs(ledger and ledger.openPosts or {}) do
    if post.price and post.price > 0 and post.qty and post.qty > 0
      and (not itemId or post.itemId == itemId) then
      local quantity = math.floor(totalBuyout / post.price + 0.5)
      if quantity >= 1 and quantity <= post.qty
        and math.abs(quantity * post.price - totalBuyout) <= 1 then
        if found then return nil end -- ambiguous: never guess which listing sold
        found = { auctionID = auctionID, post = post, quantity = quantity }
      end
    end
  end
  return found
end

-- A returned or cancelled mail often carries no buyout to match against.
-- When the item is known and exactly one posting for it is open, that
-- posting is the mail's subject; two open postings are ambiguous and must
-- not be guessed.
local function uniquePostForItem(itemId)
  if not itemId then return nil end
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  local found
  for auctionID, post in pairs(ledger and ledger.openPosts or {}) do
    if post.itemId == itemId then
      if found then return nil end
      found = { auctionID = auctionID, post = post, quantity = post.qty }
    end
  end
  return found
end

-- A sale an older addon version booked as an inference, before the mailbox
-- was opened. The mail is the confirmation of that same trade, so it must
-- upgrade the label, not book the revenue again.
local function inferredSale(itemId, total)
  local ledger = WAH.Ledger and WAH.Ledger.current() or nil
  local found
  for _, trade in ipairs(ledger and ledger.trades or {}) do
    if trade.inferred and trade.channel == "auction" and trade.auctionID
      and trade.itemId == itemId
      and math.abs((trade.price or 0) * (trade.qty or 0) - total) <= 1 then
      if found then return nil end -- ambiguous: never pick one of several
      found = trade
    end
  end
  return found
end

-- The invoice's item name is part of the identity: using the resolved
-- itemId instead would make a repeat visit look new whenever the name index
-- could not resolve the item (for example after the posting was closed).
local function fingerprint(header, invoice)
  return table.concat({
    header.subject or "",
    tostring(header.money or 0),
    tostring(invoice and invoice.consignment or 0),
    tostring(invoice and invoice.name or ""),
    tostring(invoice and invoice.buyout or 0)
  }, "|")
end
Mail.available = function()
  return type(GetInboxNumItems) == "function" and type(GetInboxHeaderInfo) == "function"
end

-- Money seen in the mailbox. Display only: the purse is GetMoney(), and the
-- terminal never budgets against uncollected mail. The estate snapshot is
-- the same value the terminal imports, so the status line cannot quote a
-- figure the estate does not have; Mail.last covers the window before the
-- first snapshot exists.
Mail.pendingCash = function()
  local scope = WAH.Estate and WAH.Estate.currentCharacterScope()
  if scope and scope.pendingCash ~= nil then return scope.pendingCash end
  return (Mail.last and Mail.last.cash) or 0
end

Mail.scan = function()
  local stats = { available = Mail.available(), messages = 0, sold = 0, expired = 0,
    won = 0, returned = 0, unattributed = 0, duplicates = 0, reconfirmed = 0, cash = 0 }
  Mail.last = stats
  if not stats.available then return stats end
  if WAH.settings and WAH.settings.mailCapture == false then return stats end
  if MailFrame and MailFrame.IsShown and not MailFrame:IsShown() then return stats end
  local okCount, count = pcall(GetInboxNumItems)
  if not okCount or not count then return stats end
  stats.messages = count
  local store = seenStore()
  local tally = {}
  local index = nameIndex()
  for message = 1, count do
    local okHeader, header = pcall(headerAt, message)
    if okHeader and header then
      -- Money sitting in the inbox is earned but not spendable: the purse
      -- (GetMoney) is the only live balance, and this is a display-only
      -- in-transit figure.
      stats.cash = stats.cash + (header.money or 0)
      local invoice = invoiceAt(message)
      local texts = { header.subject, invoice and invoice.name or "" }
      local itemId = itemFromLink(message) or itemFromText(texts, index)
      -- Money without a returned item is a sale. The commission is not part
      -- of the classifier: a cheap sale can legitimately carry a zero cut,
      -- and keying on it dropped those confirmed sales entirely. A returned
      -- item with an invoice is either an expiry or a won bid; the invoice
      -- kind tells them apart when the client provides it, and a seller's
      -- returned item without a kind stays an expiry.
      local kind = invoiceKind(invoice)
      local isSale = header.money > 0 and invoice ~= nil and not header.hasItem
      local isWon = invoice ~= nil and header.hasItem and kind == "won"
      local isCancel = invoice ~= nil and header.hasItem and kind == "cancelled"
      local isExpiry = invoice ~= nil and header.hasItem and not isWon and not isCancel
      if isSale or isWon or isCancel or isExpiry then
        local total
        if isSale then
          total = invoice.buyout > 0 and invoice.buyout or header.money
        elseif isWon then
          total = invoice.bid > 0 and invoice.bid or invoice.buyout or 0
        else
          total = invoice.buyout or 0
        end
        local matched = matchPost(itemId, total)
        if not matched and (isCancel or isExpiry) then
          matched = uniquePostForItem(itemId)
        end
        itemId = itemId or (matched and matched.post.itemId)
        local mark = fingerprint(header, invoice)
        if not itemId then
          -- No link, no name match, no unique open posting. Booking an
          -- unknown item would corrupt both the position and the fill
          -- label, so the mail is counted and deliberately left out of the
          -- tally: a later scan that knows the name must still book it.
          stats.unattributed = stats.unattributed + 1
        elseif isSale then
          local inferred = (not matched) and inferredSale(itemId, total) or nil
          -- A fingerprint already in the store was booked on an earlier
          -- visit; the posting is closed by then, so `matched` is nil even
          -- though the sale is known.
          local alreadyBooked = (tally[mark] or 0) < (store.counts[mark] or 0)
          if not matched and not inferred then
            -- The sale is real but its posting is not in this character's
            -- ledger: it predates the addon or the journal checkpoint. The
            -- mail proves revenue, never the units that produced it.
            -- Booking a guessed quantity would consume the wrong lots and
            -- report a fabricated profit, so the mail is counted and left
            -- unmarked: an ambiguous match may become unambiguous on a
            -- later visit, and the estate reconciler surfaces the cash.
            if alreadyBooked then
              stats.duplicates = stats.duplicates + 1
            else
              stats.unattributed = stats.unattributed + 1
            end
          elseif not firstUnbooked(store, tally, mark) then
            stats.duplicates = stats.duplicates + 1
          elseif inferred then
            WAH.recordEvent({
              k = "confirm",
              auctionID = inferred.auctionID,
              itemId = itemId,
              qty = inferred.qty,
              price = inferred.price,
              fee = invoice.consignment,
              listedAt = inferred.listedAt,
              censored = true
            })
            stats.reconfirmed = stats.reconfirmed + 1
          else
            WAH.recordEvent({
              k = "sold",
              auctionID = matched.auctionID,
              itemId = itemId,
              qty = matched.quantity,
              price = matched.post.price,
              fee = invoice.consignment,
              listedAt = matched.post.at,
              censored = true,
              inferred = false
            })
            stats.sold = stats.sold + 1
          end
        elseif isWon then
          -- A won bid is a purchase: the client already took the bid amount
          -- out of the purse, and the item only exists in the mailbox. Not
          -- booking it left the bag and the ledger permanently disagreeing.
          -- Without a price the mail is not a costed purchase; count it.
          if total <= 0 then
            stats.unattributed = stats.unattributed + 1
          elseif firstUnbooked(store, tally, mark) then
            WAH.recordEvent({
              k = "buy",
              itemId = itemId,
              qty = attachmentQuantity(message),
              cost = total,
              auctionID = matched and matched.auctionID or nil,
              priceSource = "mail",
              censored = true
            })
            stats.won = stats.won + 1
          else
            stats.duplicates = stats.duplicates + 1
          end
        elseif isCancel then
          -- The goods came back with the deposit. If the posting is still
          -- open, close it; otherwise the return is already a state fact in
          -- the estate and only needs counting.
          if firstUnbooked(store, tally, mark) then
            if matched then
              -- The client can also fire a cancel event for the same
              -- auction; Actions collapses the second fact.
              if WAH.Actions and WAH.Actions.cancel then
                WAH.Actions.cancel(matched.auctionID)
              else
                WAH.recordEvent({ k = "cancel", auctionID = matched.auctionID })
              end
            end
            stats.returned = stats.returned + 1
          else
            stats.duplicates = stats.duplicates + 1
          end
        elseif matched then
          -- An expired listing the addon never saw expire: the deposit is
          -- lost, the goods came back. Only book it when the posting is
          -- still open, or the event would double-count.
          if firstUnbooked(store, tally, mark) then
            if WAH.Actions and WAH.Actions.expire then
              WAH.Actions.expire(matched.auctionID)
            else
              WAH.recordEvent({ k = "expire", auctionID = matched.auctionID })
            end
            stats.expired = stats.expired + 1
          else
            stats.duplicates = stats.duplicates + 1
          end
        end
      end
    end
  end
  commitTally(store, tally)
  return stats
end

Mail.diagnostics = function()
  local lines = {}
  local function line(text) lines[#lines + 1] = text end
  line(string.format("mail: inbox API %s, invoice API %s",
    type(GetInboxNumItems) == "function" and "present" or "missing",
    type(GetInboxInvoiceInfo) == "function" and "present" or "missing"))
  line(string.format("mail: CanCheckInbox %s",
    C_Mail and C_Mail.CanCheckInbox and tostring(C_Mail.CanCheckInbox()) or "n/a"))
  if Mail.available() then
    local okCount, count = pcall(GetInboxNumItems)
    line(string.format("mail: messages %s", okCount and tostring(count) or "error"))
    if okCount and count and count > 0 then
      local okHeader, header = pcall(headerAt, 1)
      if okHeader and header then
        line(string.format("mail: header[1] subject %q money %d hasItem %s attachments %d",
          header.subject, header.money, tostring(header.hasItem), header.attachments))
      end
      local invoice = invoiceAt(1)
      line(invoice and string.format("mail: invoice[1] type %s name %s buyout %d deposit %d consignment %d",
        tostring(invoice.kind), tostring(invoice.name), invoice.buyout, invoice.deposit, invoice.consignment)
        or "mail: invoice[1] none")
      line(string.format("mail: item link %s", tostring(itemFromLink(1))))
    end
  end
  line(string.format("mail: seen %d fingerprints", #seenStore().order))
  local last = Mail.last
  if last then
    line(string.format("mail: last scan %d messages, %d sold, %d confirmed, %d expired, %d won, %d returned, %d duplicates, %d unattributed",
      last.messages, last.sold, last.reconfirmed, last.expired, last.won or 0, last.returned or 0,
      last.duplicates, last.unattributed))
  end
  return lines
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("MAIL_SHOW")
frame:RegisterEvent("MAIL_INBOX_UPDATE")
frame:SetScript("OnEvent", function(_, event)
  if event == "MAIL_SHOW" or event == "MAIL_INBOX_UPDATE" then
    local stats = Mail.scan()
    -- A confirmed sale is the fill model's clean label; flush it now so the
    -- desktop sees it without waiting for the next auction scan.
    if stats.sold + stats.expired + stats.reconfirmed > 0 and WAH.flush then WAH.flush() end
    if stats.sold > 0 or stats.expired > 0 then
      DEFAULT_CHAT_FRAME:AddMessage(string.format("|cff33ff99WAH|r %s",
        string.format(WAH.L.MAIL_BOOKED, stats.sold, stats.expired)))
    end
  end
end)

WAH.Mail = Mail
