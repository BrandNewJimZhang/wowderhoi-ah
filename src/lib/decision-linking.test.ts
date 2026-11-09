import { describe, expect, it } from "vitest";
import { ATTRIBUTION_WINDOW_DAYS, linkTrades, mergeAdoptedDecisions } from "@/lib/decision-linking";

const DAY = 24 * 60 * 60 * 1000;
const ADOPTED_AT = new Date("2026-11-01T10:00:00Z");
const at = (days: number) => new Date(ADOPTED_AT.getTime() + days * DAY);

const adoption = {
  decisionId: "R|A|1:7:sell",
  itemId: 7,
  kind: "sell",
  adoptedAt: ADOPTED_AT
};

type Trade = { itemId: number; realizedAt: Date; decisionId?: string | null };
const trade = (itemId: number, realizedAt: Date, decisionId?: string): Trade =>
  decisionId === undefined ? { itemId, realizedAt } : { itemId, realizedAt, decisionId };

describe("linkTrades", () => {
  it("links a same-item sale after adoption", () => {
    const [linked] = linkTrades([trade(7, at(1))], [adoption]);
    expect(linked.decisionId).toBe(adoption.decisionId);
  });

  it("does not link a sale before the adoption", () => {
    const [linked] = linkTrades([trade(7, at(-1))], [adoption]);
    expect(linked.decisionId).toBeUndefined();
  });

  it("does not link a sale past the attribution window", () => {
    const [linked] = linkTrades(
      [trade(7, at(ATTRIBUTION_WINDOW_DAYS + 1))],
      [adoption]
    );
    expect(linked.decisionId).toBeUndefined();
  });

  it("does not link a sale of another item", () => {
    const [linked] = linkTrades([trade(8, at(1))], [adoption]);
    expect(linked.decisionId).toBeUndefined();
  });

  it("keeps an identity the replay already carries", () => {
    const [linked] = linkTrades([trade(7, at(1), "existing")], [adoption]);
    expect(linked.decisionId).toBe("existing");
  });

  it("uses the latest adoption before the sale", () => {
    const later = { ...adoption, decisionId: "later", adoptedAt: at(0.5) };
    const [linked] = linkTrades([trade(7, at(1))], [adoption, later]);
    expect(linked.decisionId).toBe("later");
  });
});

describe("mergeAdoptedDecisions", () => {
  const tick = new Date("2026-11-02T10:00:00Z");

  it("keeps stored adoptions regardless of scan age and applies fresh adopt events", () => {
    const merged = mergeAdoptedDecisions(
      [
        { decisionId: "old", itemId: 7, kind: "sell", adoptedAt: ADOPTED_AT },
        { decisionId: "unadopted", itemId: 7, kind: "buy", adoptedAt: null },
        { decisionId: null, itemId: 7, kind: "buy", adoptedAt: ADOPTED_AT }
      ],
      [
        { decisionId: "old", itemId: 7, kind: "sell", adoptedAt: null },
        { decisionId: "new", itemId: 8, kind: "buy", adoptedAt: null }
      ],
      new Map([["new", tick]])
    );
    expect(merged).toEqual([
      { decisionId: "old", itemId: 7, kind: "sell", adoptedAt: ADOPTED_AT },
      { decisionId: "new", itemId: 8, kind: "buy", adoptedAt: tick }
    ]);
  });

  it("lets an event override the stored adoption time", () => {
    const merged = mergeAdoptedDecisions(
      [{ decisionId: "d", itemId: 7, kind: "sell", adoptedAt: ADOPTED_AT }],
      [],
      new Map([["d", tick]])
    );
    expect(merged[0].adoptedAt).toEqual(tick);
  });
});

describe("linkTrades kind", () => {
  it("does not attach a sale to a buy recommendation", () => {
    const buy = { ...adoption, decisionId: "R|A|1:7:buy", kind: "buy" };
    const [linked] = linkTrades([trade(7, at(1))], [buy]);
    expect(linked.decisionId).toBeUndefined();
  });
});
