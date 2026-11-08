import { describe, expect, it } from "vitest";
import { placeholderItemName } from "@/lib/item-name";

describe("placeholderItemName", () => {
  it("produces the stable #id marker used by scan imports", () => {
    expect(placeholderItemName(700)).toBe("#700");
  });
});
