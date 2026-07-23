import { describe, expect, it } from "vitest";
import { qualityColorClass } from "@/lib/quality";

describe("qualityColorClass", () => {
  it("maps WoW item qualities to their canonical colors", () => {
    expect(qualityColorClass("poor")).toBe("text-wow-poor");
    expect(qualityColorClass("common")).toBe("text-wow-common");
    expect(qualityColorClass("uncommon")).toBe("text-wow-uncommon");
    expect(qualityColorClass("rare")).toBe("text-wow-rare");
    expect(qualityColorClass("epic")).toBe("text-wow-epic");
    expect(qualityColorClass("legendary")).toBe("text-wow-legendary");
  });

  it("falls back to common white for unknown qualities", () => {
    expect(qualityColorClass("unknown")).toBe("text-wow-common");
    expect(qualityColorClass("")).toBe("text-wow-common");
  });
});
