import { describe, expect, it } from "vitest";
import { isPlaceholderItemName, placeholderItemName } from "@/lib/item-name";

describe("placeholderItemName", () => {
  it("produces the stable #id marker used by scan imports", () => {
    expect(placeholderItemName(700)).toBe("#700");
  });
});

describe("isPlaceholderItemName", () => {
  it("recognizes the marker for the same item", () => {
    expect(isPlaceholderItemName("#700", 700)).toBe(true);
  });

  it("does not mistake a real name for a marker", () => {
    expect(isPlaceholderItemName("精金矿石", 700)).toBe(false);
  });

  it("does not accept another item's marker", () => {
    expect(isPlaceholderItemName("#701", 700)).toBe(false);
  });
});
