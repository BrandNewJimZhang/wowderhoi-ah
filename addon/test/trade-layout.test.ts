// The WAH page draws its own backdrop, and a backdrop's border art is
// rendered *inside* the frame's bounds -- so every number in this file is
// about one rule: nothing the page draws may land on the edge it draws for
// itself. The panel had the title's corner, the row icons and the last row
// sitting on the bevel, which is what "some text overflows" looks like.

import { describe, expect, it } from "vitest";
import { loadAddon, type WowLua } from "./wow-lua";

// The page pins two corners to AuctionFrame, so the client's height decides
// the panel's. Tests set it explicitly instead of inheriting a default.
function layout(auctionFrameHeight = 447): WowLua {
  const lua = loadAddon();
  lua.exec(`AuctionFrame:SetSize(800, ${auctionFrameHeight})`);
  lua.openTab();
  return lua;
}

const SIDES = [
  { anchor: "LEFT", inset: "left" },
  { anchor: "RIGHT", inset: "right" },
  { anchor: "TOP", inset: "top" },
  { anchor: "BOTTOM", inset: "bottom" }
] as const;

describe("trade panel layout", () => {
  it.each(SIDES)("keeps content off the border art along the $inset edge", ({ anchor, inset }) => {
    const lua = layout();
    // Measured against the backdrop's own declared inset rather than a
    // number chosen here, so the two can never drift apart.
    expect(lua.clearance(anchor)).toBeGreaterThanOrEqual(lua.backdropInset(inset));
  });

  it("never lets a fixed-width column wrap into the row below it", () => {
    // A column is pinned to 92px inside a 22px row. Wrapping is the one way
    // a cell can grow taller than the row that holds it, and the row below
    // is what it grows into -- a fixed width and a fixed height together
    // mean word wrap has to be off, on every cell and every header.
    expect(layout().wrappingCells()).toBe(0);
  });

  it("fits the row count to the panel instead of assuming one", () => {
    const tall = layout();
    const short = layout(360);
    // 447 - 70 above - 38 below = 339 of panel; 72 goes to the header block
    // and 8 to the bottom border, leaving 11 whole 22px rows.
    expect(tall.visibleRows()).toBe(11);
    expect(short.visibleRows()).toBeLessThan(tall.visibleRows());
    // The count that matters is the one that still clears the bottom edge,
    // at whatever height the client hands the page.
    for (const panel of [tall, short]) {
      expect(panel.clearance("BOTTOM")).toBeGreaterThanOrEqual(panel.backdropInset("bottom"));
    }
  });
});
