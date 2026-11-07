import { describe, expect, it } from "vitest";
import cases from "../../data/search-parity.json";
import { parseSearchQuery, rankSearch } from "@/lib/search";

type SearchCase = {
  query: string;
  candidates: Array<{ itemId: number; name: string; booked?: boolean; quantity?: number }>;
  expected: number[];
};

const CASES = cases as SearchCase[];

describe("shared search ranking", () => {
  for (const testCase of CASES) {
    it(`ranks ${JSON.stringify(testCase.query)} like the addon`, () => {
      expect(rankSearch(testCase.candidates, testCase.query).map((candidate) => candidate.itemId))
        .toEqual(testCase.expected);
    });
  }

  it("parses a bare id and an item hyperlink id", () => {
    expect(parseSearchQuery("4338")).toEqual({ text: "4338", id: 4338, tokens: ["4338"] });
    expect(parseSearchQuery("item:4338")).toMatchObject({ id: 4338 });
    expect(parseSearchQuery("  ")).toBeNull();
  });
});
