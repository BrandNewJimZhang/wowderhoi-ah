// The estate publisher is the state half of the system: bag, bank, mail,
// own postings and cash change between scans, and the terminal must read the
// state that actually exists rather than the scan-frozen projection.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

const LINEN = 2589;
const MAGEWEAVE = 4338;

function charScope(expression: string) {
  return `WowTest.ns.Estate.snapshot().scopes["character:Tester"].${expression}`;
}

function accountScope(expression: string) {
  return `WowTest.ns.Estate.snapshot().scopes.account.${expression}`;
}

function refresh(lua: ReturnType<typeof loadAddon>) {
  lua.exec("WowTest.advance(2)");
}

describe("estate collection", () => {
  it("aggregates the backpack and reagent bag into carried", () => {
    const lua = loadAddon();
    lua.setBag([
      { bag: 0, slot: 1, itemId: LINEN, count: 10, name: "Linen" },
      { bag: 0, slot: 2, itemId: LINEN, count: 5, name: "Linen" },
      { bag: 5, slot: 1, itemId: MAGEWEAVE, count: 3, name: "Mageweave" }
    ]);
    lua.exec("WowTest.fireEvent('BAG_UPDATE_DELAYED')");
    refresh(lua);
    expect(lua.number(charScope(`items[${LINEN}].carried.qty`))).toBe(15);
    expect(lua.number(charScope(`items[${LINEN}].carried.slots`))).toBe(2);
    expect(lua.number(charScope(`items[${MAGEWEAVE}].carried.qty`))).toBe(3);
    expect(lua.text(charScope("coverage.carried"))).toBe("observed");
  });

  it("does not treat an unopened bank as an empty bank", () => {
    const lua = loadAddon();
    lua.setBag([
      { bag: 6, slot: 1, itemId: LINEN, count: 40, name: "Linen" },
      { bag: 15, slot: 1, itemId: MAGEWEAVE, count: 7, name: "Mageweave" }
    ]);
    lua.exec("WowTest.fireEvent('BAG_UPDATE_DELAYED')");
    refresh(lua);
    expect(lua.text(charScope("coverage.bank"))).toBe("unobserved");
    expect(lua.text(accountScope("coverage.account_bank"))).toBe("unobserved");
    expect(lua.number(
      `(function() local s = WowTest.ns.Estate.snapshot().scopes["character:Tester"]`
      + ` return (s.items[${LINEN}] and s.items[${LINEN}].bank and s.items[${LINEN}].bank.qty) or -1 end)()`
    )).toBe(-1);
  });

  it("samples character and account banks once the bank is opened", () => {
    const lua = loadAddon();
    lua.setBag([
      { bag: 6, slot: 1, itemId: LINEN, count: 40, name: "Linen" },
      { bag: 15, slot: 1, itemId: MAGEWEAVE, count: 7, name: "Mageweave" }
    ]);
    lua.exec("WowTest.fireEvent('BANKFRAME_OPENED')");
    refresh(lua);
    expect(lua.number(charScope(`items[${LINEN}].bank.qty`))).toBe(40);
    expect(lua.text(charScope("coverage.bank"))).toBe("observed");
    // The account bank belongs to the account scope even though the same
    // container pass read it.
    expect(lua.number(accountScope(`items[${MAGEWEAVE}].account_bank.qty`))).toBe(7);
    expect(lua.text(accountScope("coverage.account_bank"))).toBe("observed");
  });

  it("exports mail attachments and pending cash only after a mailbox visit", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.setMail({ {
      sender = "Auction House", subject = "Sold", money = 900, hasItem = false,
      invoice = { kind = 0, name = "Linen", buyout = 900 }
    }, {
      sender = "Auction House", subject = "Won", money = 0, hasItem = true,
      attachments = { "|Hitem:${MAGEWEAVE}:0:0|h[Mageweave]|h" },
      invoice = { kind = 2, name = "Mageweave", bid = 700 }
    } })`);
    expect(lua.text(charScope("coverage.mail"))).toBe("unobserved");
    lua.exec("WowTest.fireEvent('MAIL_INBOX_UPDATE')");
    refresh(lua);
    expect(lua.text(charScope("coverage.mail"))).toBe("observed");
    expect(lua.number(charScope("pendingCash"))).toBe(900);
    expect(lua.number(charScope(`items[${MAGEWEAVE}].mail.qty`))).toBe(1);
  });

  it("publishes own postings as account-level listed stock", () => {
    const lua = loadAddon();
    lua.setOwned([{ auctionID: 11, itemId: LINEN, quantity: 4, buyoutAmount: 4000 }]);
    lua.exec("WowTest.fireEvent('OWNED_AUCTIONS_UPDATED')");
    refresh(lua);
    expect(lua.number(accountScope(`items[${LINEN}].listed.qty`))).toBe(4);
    expect(lua.text(accountScope("coverage.listed"))).toBe("observed");
  });

  it("reads cash and free slots from the live client", () => {
    const lua = loadAddon();
    lua.exec("WowTest.setMoney(123456)");
    lua.exec("WowTest.freeBagSlots = { [0] = 2, [1] = 3 }");
    lua.exec("WowTest.fireEvent('PLAYER_MONEY')");
    refresh(lua);
    expect(lua.number(charScope("cash"))).toBe(123456);
    expect(lua.number(charScope("freeSlots"))).toBe(5);
  });
});

describe("estate revision", () => {
  it("moves only when the content changes", () => {
    const lua = loadAddon();
    const first = lua.number("WowTest.ns.Estate.revision()");
    lua.exec("WowTest.fireEvent('BAG_UPDATE_DELAYED')");
    refresh(lua);
    expect(lua.number("WowTest.ns.Estate.revision()")).toBe(first);
    lua.exec("WowTest.setMoney(42)");
    lua.exec("WowTest.fireEvent('PLAYER_MONEY')");
    refresh(lua);
    expect(lua.number("WowTest.ns.Estate.revision()")).toBe(first + 1);
  });

  it("keeps the character and account scopes separate", () => {
    const lua = loadAddon();
    expect(lua.text(charScope("kind"))).toBe("character");
    expect(lua.text(accountScope("kind"))).toBe("account");
    expect(lua.text("WowTest.ns.Estate.characterKey()")).toBe("character:Tester");
  });
});
