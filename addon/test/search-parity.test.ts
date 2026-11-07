// The terminal and the addon implement the same search rules in different
// languages. This test runs the shipped Core.lua ranking over the shared
// fixture; src/lib/search.test.ts runs the TypeScript implementation over
// the same cases, so either side drifting fails one of the two.
import { describe, expect, it } from "vitest";
import cases from "../../data/search-parity.json";
import { loadAddon, toLua } from "./wow-lua";

type SearchCase = {
  query: string;
  candidates: Array<{ itemId: number; name: string; booked?: boolean; quantity?: number }>;
  expected: number[];
};

const CASES = cases as SearchCase[];

describe("Lua search ranking", () => {
  for (const testCase of CASES) {
    it(`ranks ${JSON.stringify(testCase.query)} like the terminal`, () => {
      const lua = loadAddon();
      lua.exec(`WowTest.searchRanked = WowTest.ns.Core.rankSearch(${toLua(testCase.candidates)}, ${toLua(testCase.query)})`);
      const ranked = lua.value("WowTest.searchRanked") as Array<{ itemId: number }>;
      expect(ranked.map((candidate) => candidate.itemId)).toEqual(testCase.expected);
    });
  }

  it("parses the same query shapes", () => {
    const lua = loadAddon();
    const text = lua.text(
      `(function()
        local parsed = WowTest.ns.Core.parseSearchQuery("item:4338")
        return parsed.text .. "|" .. parsed.id .. "|" .. #parsed.tokens
      end)()`
    );
    expect(text).toBe("item:4338|4338|1");
  });
});
