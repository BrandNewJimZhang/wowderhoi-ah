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
