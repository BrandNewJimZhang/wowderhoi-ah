// /wahdiag is the only tool that can answer, in the live client, which
// assumptions the offline stub cannot prove: the meaning of the time-left
// return, owner visibility, whether SaveAddOns and the posting calls exist,
// deposit arithmetic and owned-auction structure. Every line must have a
// concrete answer, even when that answer is "missing".

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

function page(): WowLua {
  const lua = loadAddon();
  lua.runScan([
    { itemId: 2589, name: "Linen", count: 10, buyout: 10000, owner: "Alice", timeLeft: 3600 },
    { itemId: 2589, name: "Linen", count: 10, buyout: 12000, owner: "Bob", timeLeft: 7200 },
    { itemId: 2589, name: "Linen", count: 10, buyout: 14000, owner: "Tester", timeLeft: 3600 }
  ]);
  lua.setBag([{ bag: 0, slot: 1, itemId: 2589, count: 10, name: "Linen", commodity: true }]);
  lua.setOwned([{ auctionID: 9001, itemId: 2589, quantity: 10, buyoutAmount: 12000, timeLeftSeconds: 3600 }]);
  lua.exec("SlashCmdList['WOWDERHOIAHDIAG']()");
  return lua;
}

describe("/wahdiag", () => {
  it("answers every live-client question with a concrete value", () => {
    const lua = page();
    expect(lua.anyChat("GetReplicateItemTimeLeft(1): 3600 (number)")).toBe(true);
    expect(lua.anyChat("owner visibility: 1 visible / 0 hidden / 1 priced items")).toBe(true);
    // The self-exclusion audit reads the same scan global the scanner writes;
    // a case-mismatched name here reported zeros forever.
    expect(lua.anyChat("own listings excluded: 1 listings / 10 units | observation v2")).toBe(true);
    expect(lua.anyChat("own exclusion channel: owner 1 / owned 0 / none 0 items")).toBe(true);
    expect(lua.anyChat("scan age:")).toBe(true);
    // The terminal can only size against bags the scan reported.
    expect(lua.anyChat("bags: 20 free now | scan recorded 20")).toBe(true);
    expect(lua.anyChat("series:")).toBe(true);
    expect(lua.anyChat("capture tiers:")).toBe(true);
    // Where a "slow scan" went: the server wait, the client calls and our
    // own Lua work are separate numbers, and the shares answer the question
    // without arithmetic in the head.
    expect(lua.anyChat("last scan: ok | saved 3/3 rows | via replicate | missing 0 | bad 0 | wait 0 ms | api 0 ms | lua 0 ms | finish 0 ms (max frame 0 ms, 1 frames) | save 0 ms")).toBe(true);
    expect(lua.anyChat("scan time split: api 0% | lua 0% | finish 0% | save 0% (wait 0%)")).toBe(true);
    expect(lua.anyChat("SaveAddOns: available")).toBe(true);
    expect(lua.anyChat("PostItem/PostCommodity: present/present")).toBe(true);
    expect(lua.anyChat("CalculateCommodityDeposit(2589,24,1): 72")).toBe(true);
    expect(lua.anyChat("owned auctions: 1")).toBe(true);
    expect(lua.anyChat("throttle ready: true")).toBe(true);
    expect(lua.anyChat("journal:")).toBe(true);
    expect(lua.anyChat("phase:")).toBe(true);
    // The capture switches are the documented rollback levers; the state
    // has to be readable or "turned it off" cannot be verified in game.
    expect(lua.anyChat("capture: mail on | craft on")).toBe(true);
  });

  it("names the phase and reason a scan stopped in", () => {
    const lua = loadAddon();
    lua.openTab();
    lua.exec("WowTest.ns.startScan()");
    lua.exec("WowTest.fireEvent('AUCTION_HOUSE_BROWSE_FAILURE')");
    lua.exec("SlashCmdList['WOWDERHOIAHDIAG']()");
    // An unanswered or failed request must not read like a completed scan.
    expect(lua.anyChat("last scan: browse_failure | waiting 0/0 rows")).toBe(true);
  });

  it("reports missing APIs as missing instead of guessing", () => {
    const lua = loadAddon();
    lua.exec("C_AuctionHouse.CalculateCommodityDeposit = nil");
    lua.exec("C_AddOns.SaveAddOns = nil");
    lua.exec("SlashCmdList['WOWDERHOIAHDIAG']()");
    expect(lua.anyChat("CalculateCommodityDeposit(2589,24,1): n/a")).toBe(true);
    expect(lua.anyChat("SaveAddOns: missing")).toBe(true);
  });
});
