import { describe, expect, it } from "vitest";
import { ATTRIBUTION_WINDOW_DAYS, linkTrades } from "@/lib/decision-linking";

const DAY = 24 * 60 * 60 * 1000;
const ADOPTED_AT = new Date("2026-11-01T10:00:00Z");
const at = (days: number) => new Date(ADOPTED_AT.getTime() + days * DAY);

const adoption = {
  decisionId: "R|A|1:7:sell",
  itemId: 7,
  kind: "sell",
  adoptedAt: ADOPTED_AT
};

type Trade = {
  itemId: number;
  realizedAt: Date;
  listedAt?: Date;
  observedAt?: Date;
  decisionId?: string | null;
};
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

  it("links a sale listed inside the window even when the mailbox was opened later", () => {
    const [linked] = linkTrades(
      [{ itemId: 7, realizedAt: at(10), listedAt: at(1), observedAt: at(10) }] as Trade[],
      [adoption]
    );
    expect(linked.decisionId).toBe(adoption.decisionId);
  });

  it("does not link a sale that was already listed before the adoption", () => {
    const [linked] = linkTrades(
      [{ itemId: 7, realizedAt: at(2), listedAt: at(-1), observedAt: at(2) }] as Trade[],
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

describe("linkTrades kind", () => {
  it("does not attach a sale to a buy recommendation", () => {
    const buy = { ...adoption, decisionId: "R|A|1:7:buy", kind: "buy" };
    const [linked] = linkTrades([trade(7, at(1))], [buy]);
    expect(linked.decisionId).toBeUndefined();
  });
});
