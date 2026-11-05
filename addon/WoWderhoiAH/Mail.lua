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
-- Counts never decrease, so deleting a mail cannot make a later identical
-- one book twice.
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
  while #store.order > SEEN_CAP do
    local oldest = table.remove(store.order, 1)
    store.counts[oldest] = nil
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

local function itemFromLink(index)
  if type(GetInboxItemLink) ~= "function" then return nil end
  for attachment = 1, 8 do
    local ok, link = pcall(GetInboxItemLink, index, attachment)
    if not ok or not link then break end
    local itemId = tonumber(tostring(link):match("item:(%d+)"))
    if itemId then return itemId end
  end
  return nil
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
  -- Trades matter when the posting is already closed: a sale the reconcile
  -- inferred removed its post, and the mail that confirms it arrives after.
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

-- A sale the owned-list reconcile already booked as an inference, before
-- the mailbox was opened. The mail is the confirmation of that same trade,
-- so it must upgrade the label, not book the revenue again.
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

-- Money seen in the mailbox at the last scan. Display only: the purse is
-- GetMoney(), and the terminal never budgets against uncollected mail.
Mail.pendingCash = function()
  return (Mail.last and Mail.last.cash) or 0
end

Mail.scan = function()
  local stats = { available = Mail.available(), messages = 0, sold = 0, expired = 0,
    unattributed = 0, duplicates = 0, reconfirmed = 0, cash = 0 }
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
      -- and keying on it dropped those confirmed sales entirely.
      local isSale = header.money > 0 and invoice ~= nil and not header.hasItem
      local isExpiry = header.hasItem and header.money == 0 and invoice ~= nil
      if isSale or isExpiry then
        local total = isSale and (invoice.buyout > 0 and invoice.buyout or header.money) or (invoice.buyout or 0)
        local matched = matchPost(itemId, total)
        itemId = itemId or (matched and matched.post.itemId)
        local mark = fingerprint(header, invoice)
        if not itemId then
          -- No link, no name match, no unique open posting. Booking an
          -- unknown item would corrupt both the position and the fill
          -- label, so the mail is counted and deliberately left out of the
          -- tally: a later scan that knows the name must still book it.
          stats.unattributed = stats.unattributed + 1
        elseif isSale then
          if not firstUnbooked(store, tally, mark) then
            stats.duplicates = stats.duplicates + 1
          else
            local inferred = (not matched) and inferredSale(itemId, total) or nil
            if inferred then
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
              local quantity = matched and matched.quantity or 1
              local unitPrice = matched and matched.post.price or total
              WAH.recordEvent({
                k = "sold",
                auctionID = matched and matched.auctionID or nil,
                itemId = itemId,
                qty = quantity,
                price = unitPrice,
                fee = invoice.consignment,
                listedAt = matched and matched.post.at or nil,
                censored = true,
                inferred = false
              })
              stats.sold = stats.sold + 1
            end
          end
        elseif matched then
          -- An expired listing the addon never saw expire: the deposit is
          -- lost, the goods came back. Only book it when the posting is
          -- still open, or the event would double-count.
          if firstUnbooked(store, tally, mark) then
            WAH.recordEvent({ k = "expire", auctionID = matched.auctionID })
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
    line(string.format("mail: last scan %d messages, %d sold, %d confirmed, %d expired, %d duplicates, %d unattributed",
      last.messages, last.sold, last.reconfirmed, last.expired, last.duplicates, last.unattributed))
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
