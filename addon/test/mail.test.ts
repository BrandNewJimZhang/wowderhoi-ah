// The mailbox is the only place the client reports a collected sale. These
// tests drive real mails through Mail.scan and assert the journal: a sale
// must become a confirmed (inferred = false) trade, a repeat scan must not
// book it twice, and an unattributable mail must never be guessed.
import { describe, expect, it } from "vitest";
import { loadAddon, toLua, type WowLua } from "./wow-lua";

function record(lua: WowLua, event: Record<string, unknown>) {
  lua.exec(`WowTest.ns.recordEvent(${toLua(event)})`);
}

function scan(lua: WowLua) {
  lua.exec("WowTest.mailStats = WowTest.ns.Mail.scan()");
  const read = (field: string) => lua.number(`WowTest.mailStats.${field}`);
  return {
    messages: read("messages"),
    sold: read("sold"),
    expired: read("expired"),
    unattributed: read("unattributed"),
    duplicates: read("duplicates"),
    reconfirmed: read("reconfirmed"),
    won: read("won"),
    returned: read("returned"),
    ignored: read("ignored")
  };
}

function saleMail(subject: string, name: string, buyout: number, consignment: number, money: number) {
  return {
    subject,
    money,
    invoice: { kind: "seller", name, player: "Buyer", buyout, deposit: 500, consignment }
  };
}

describe("mailbox capture", () => {
  it("books a collected sale as a confirmed trade", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 10, price: 1200, deposit: 500 });
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful: 亚麻布", "亚麻布", 12000, 600, 11400))} })`);

    expect(scan(lua).sold).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('sold').inferred == false and 1 or 0")).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('sold').qty")).toBe(10);
    expect(lua.number("WowTest.ns.Journal.last('sold').price")).toBe(1200);
    expect(lua.number("WowTest.ns.Journal.last('sold').fee")).toBe(600);
    // 12000 - 600 - 8000 = 3400, deposit refunded on sale.
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(3400);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
  });

  it("does not book the same mail twice", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 4, cost: 4000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 4, price: 1200, deposit: 100 });
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 4800, 240, 4560))} })`);
    expect(scan(lua).sold).toBe(1);
    const result = scan(lua);
    expect(result.sold).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(3);
  });

  it("books two identical sale mails instead of treating the second as a duplicate", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 1000 });
    record(lua, { k: "post", auctionID: 8, itemId: 2589, qty: 10, price: 100, deposit: 300 });
    // A commodity listing that filled in two equal pieces produces two
    // mails with the same subject, item and amounts. Only a count, not a
    // set, can tell them apart.
    const mail = toLua(saleMail("Auction successful", "亚麻布", 500, 25, 475));
    lua.exec(`WowTest.setMail({ ${mail}, ${mail} })`);

    const result = scan(lua);
    expect(result.sold).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589] == nil and 0 or WowTest.ns.Ledger.positions()[2589].qty")).toBe(0);
  });

  it("books only the identical mail that arrived after the last visit", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 20, cost: 2000 });
    record(lua, { k: "post", auctionID: 9, itemId: 2589, qty: 20, price: 100, deposit: 300 });
    const mail = toLua(saleMail("Auction successful", "亚麻布", 500, 25, 475));
    lua.exec(`WowTest.setMail({ ${mail} })`);
    expect(scan(lua).sold).toBe(1);

    lua.exec(`WowTest.setMail({ ${mail}, ${mail} })`);
    const result = scan(lua);
    expect(result.sold).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(4);
  });

  it("keeps guarding a mail that is still in the inbox when the seen store is full", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 4, cost: 4000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 4, price: 1200, deposit: 100 });
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 4800, 240, 4560))} })`);
    expect(scan(lua).sold).toBe(1);
    // Fill the store to its cap with fingerprints that are no longer in the
    // inbox, leaving the sale's fingerprint as the oldest entry. A blind cap
    // would evict it while its mail is still there, and the next scan would
    // book the same sale again.
    lua.exec(`
      local old = WoWderhoiAH_MailSeen
      local sale
      for fingerprint in pairs(old.counts) do sale = fingerprint end
      local store = { v = 2, counts = { [sale] = 1 }, order = { sale } }
      for index = 1, 500 do
        local key = "gone|" .. index
        store.counts[key] = 1
        store.order[#store.order + 1] = key
      end
      WoWderhoiAH_MailSeen = store
    `);
    expect(scan(lua).sold).toBe(0);
    // The third visit is where an evicted guard resurfaced: the store now
    // holds 500 entries and the sale's mail is still unread.
    expect(scan(lua).sold).toBe(0);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(3);
  });

  it("books an unattributable mail once a later scan can name the item", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful: 亚麻布", "亚麻布", 1200, 60, 1140))} })`);
    // No scan and no ledger posting can name the item yet.
    expect(scan(lua).unattributed).toBe(1);
    // The posting names it from now on: the skipped mail must still book.
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 1, price: 1200, deposit: 0 });
    expect(scan(lua).sold).toBe(1);
  });

  it("flushes SavedVariables when a sale is booked, not on a repeat visit", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 4, cost: 4000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 4, price: 1200, deposit: 100 });
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 4800, 240, 4560))} })`);
    lua.exec("WowTest.savedCount = 0");

    lua.exec("WowTest.fireEvent('MAIL_SHOW')");
    // The terminal must see the confirmed sale now, not at the next scan.
    expect(lua.number("WowTest.savedCount")).toBe(1);
    lua.exec("WowTest.fireEvent('MAIL_SHOW')");
    expect(lua.number("WowTest.savedCount")).toBe(1);
  });

  it("resolves each ledger item once per mailbox visit", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    for (let index = 0; index < 6; index += 1) {
      record(lua, { k: "sold", auctionID: 100 + index, itemId: 2589, qty: 1, price: 100, fee: 5, inferred: true });
    }
    lua.exec("WowTest.itemInfoCalls = 0");
    lua.exec("WowTest.setMail({})");
    scan(lua);
    // Six trades name the same item; the name index must ask the client once.
    expect(lua.number("WowTest.itemInfoCalls")).toBe(1);
  });

  it("confirms a sale that reconciled inference booked before the mailbox", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 4, cost: 4000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 4, price: 1200, deposit: 100 });
    // The listing vanished from the owned list before the mailbox was
    // opened: the sell panel booked it as an inferred sale and closed the
    // posting. The mail must confirm that trade, not book it a second time.
    record(lua, { k: "sold", auctionID: 7, itemId: 2589, qty: 4, price: 1200, fee: 240, inferred: true });
    const realized = lua.number("WowTest.ns.Ledger.capital().realized");
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 4800, 240, 4560))} })`);

    const result = scan(lua);
    expect(result.sold).toBe(0);
    expect(result.reconfirmed).toBe(1);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(4);
    expect(lua.number("WowTest.ns.Ledger.current().trades[1].inferred == false and 1 or 0")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.capital().realized")).toBe(realized);
    // The sale now counts as a clean fill label.
    expect(lua.number("WowTest.ns.Ledger.salesSince(86400)[2589].samples")).toBe(1);
  });

  it("books a commodity partial fill and keeps the rest of the posting open", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 20, cost: 2000 });
    record(lua, { k: "post", auctionID: 8, itemId: 2589, qty: 20, price: 100, deposit: 300 });
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 500, 25, 475))} })`);
    expect(scan(lua).sold).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('sold').qty")).toBe(5);
    // The listing still holds 15 units and its deposit stays in escrow.
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(15);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(300);

    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 1500, 75, 1425))} })`);
    expect(scan(lua).sold).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('sold').qty")).toBe(15);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
  });

  it("books a sale whose commission is zero", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 1, cost: 10 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 1, price: 15, deposit: 1 });
    // A cheap sale can carry no commission at all. Money without an item
    // attachment is the sale signal; the cut is not part of the classifier.
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 15, 0, 15))} })`);
    expect(scan(lua).sold).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('sold').inferred == false and 1 or 0")).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('sold').fee")).toBe(0);
  });

  it("books an expired listing from the returned-item mail", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 5, cost: 5000 });
    record(lua, { k: "post", auctionID: 9, itemId: 2589, qty: 5, price: 1200, deposit: 300 });
    lua.exec(`WowTest.setMail({ {
      subject = "Auction expired: 亚麻布", money = 0, hasItem = true,
      attachments = { "|Hitem:2589:0:0:0|h[亚麻布]|h" },
      invoice = { kind = "seller", name = "亚麻布", buyout = 6000, deposit = 300, consignment = 0 }
    } })`);
    expect(scan(lua).expired).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.capital().depositsLost")).toBe(300);
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(5);
  });

  it("stops booking once capture is switched off", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 10, price: 1200, deposit: 500 });
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 12000, 600, 11400))} })`);
    // The documented rollback lever has to work from inside the game: a
    // broken invoice parser must be switchable off without editing files.
    lua.exec("SlashCmdList['WOWDERHOIAHCAPTURE']('mail off')");
    expect(lua.eval("WowTest.ns.settings.mailCapture")).toBe(false);
    expect(scan(lua).sold).toBe(0);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(2);
    lua.exec("SlashCmdList['WOWDERHOIAHCAPTURE']('mail on')");
    expect(lua.eval("WowTest.ns.settings.mailCapture")).toBe(true);
    expect(scan(lua).sold).toBe(1);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(3);
  });

  it("counts an unattributable sale instead of guessing an item", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful: 陌生物品", "陌生物品", 5000, 250, 4750))} })`);
    const result = scan(lua);
    expect(result.unattributed).toBe(1);
    expect(result.sold).toBe(0);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(0);
  });

  it("measures the sale exposure from the posting time, not the mailbox visit", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 4, cost: 4000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 4, price: 1200, deposit: 100 });
    lua.exec("WowTest.advance(7200)");
    lua.exec(`WowTest.setMail({ ${toLua(saleMail("Auction successful", "亚麻布", 4800, 240, 4560))} })`);
    scan(lua);
    // The mail is observed two hours after the posting: exposure 2h, not
    // the 15-minute scan floor.
    expect(lua.text("(function() return string.format('%.2f', WowTest.ns.Ledger.salesSince(86400)[2589].exposedHours) end)()"))
      .toBe("2.00");
  });
});

describe("mail invoice kinds", () => {
  it("books a won bid as a purchase with the paid amount as cost", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    lua.exec(`WowTest.setMail({ {
      subject = "Auction won: 亚麻布",
      money = 0,
      hasItem = true,
      attachments = { "|Hitem:2589:0:0|h[亚麻布]|h" },
      invoice = { kind = 2, name = "亚麻布", bid = 700, buyout = 900 }
    } })`);
    const result = scan(lua);
    expect(result.won).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('buy').cost")).toBe(700);
    expect(lua.number("(WowTest.ns.Ledger.positions()[2589] or {}).qty or 0")).toBe(1);
  });

  it("books a won bid as the attached stack, not one unit", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    lua.exec(`WowTest.setMail({ {
      subject = "Auction won: 亚麻布",
      money = 0,
      hasItem = true,
      attachmentItems = { { name = "亚麻布", itemId = 2589, count = 20 } },
      invoice = { kind = 2, name = "亚麻布", bid = 700, buyout = 900 }
    } })`);
    const result = scan(lua);
    expect(result.won).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('buy').qty")).toBe(20);
    expect(lua.number("(WowTest.ns.Ledger.positions()[2589] or {}).qty or 0")).toBe(20);
  });

  it("closes an open posting on a returned cancelled mail", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 10, price: 1200, deposit: 500 });
    lua.exec(`WowTest.setMail({ {
      subject = "Auction cancelled: 亚麻布",
      money = 500,
      hasItem = true,
      attachments = { "|Hitem:2589:0:0|h[亚麻布]|h" },
      invoice = { kind = "cancelled", name = "亚麻布", buyout = 0, deposit = 500 }
    } })`);
    const result = scan(lua);
    expect(result.returned).toBe(1);
    expect(lua.number("WowTest.ns.Journal.last('cancel') == nil and 0 or 1")).toBe(1);
    expect(lua.number("WowTest.ns.Ledger.capital().escrow")).toBe(0);
    // The goods came back and were never consumed.
    expect(lua.number("WowTest.ns.Ledger.positions()[2589].qty")).toBe(10);
  });

  it("does not book a cancel a second time when the client event follows the mail", () => {
    const lua = loadAddon();
    lua.exec('WowTest.itemInfo[2589] = { name = "亚麻布" }');
    record(lua, { k: "buy", itemId: 2589, qty: 10, cost: 8000 });
    record(lua, { k: "post", auctionID: 7, itemId: 2589, qty: 10, price: 1200, deposit: 500 });
    lua.exec(`WowTest.setMail({ {
      subject = "Auction cancelled: 亚麻布", money = 500, hasItem = true,
      attachments = { "|Hitem:2589:0:0|h[亚麻布]|h" },
      invoice = { kind = "cancelled", name = "亚麻布", buyout = 0, deposit = 500 }
    } })`);
    expect(scan(lua).returned).toBe(1);
    lua.exec("WowTest.fireEvent('AUCTION_CANCELED', 7)");
    expect(lua.number(`(function()
      local n = 0
      for _, event in ipairs(WowTest.ns.Journal.current()) do
        if event.k == "cancel" then n = n + 1 end
      end
      return n
    end)()`)).toBe(1);
  });

  it("ignores a player mail with no invoice", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.setMail({ {
      subject = "thanks", money = 100, hasItem = true,
      attachments = { "|Hitem:2589:0:0|h[Linen]|h" }
    } })`);
    const result = scan(lua);
    expect(result.sold + result.won + result.returned + result.expired).toBe(0);
    expect(lua.number("WowTest.ns.Journal.count()")).toBe(0);
  });
});
