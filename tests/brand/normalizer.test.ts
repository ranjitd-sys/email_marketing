import { describe, expect, test } from "bun:test";
import {
  extractBrandFromByline,
  isBrandLabel,
  isPlausibleBrandName,
  normalizeBrandName,
} from "../../src/brand/normalizer";

describe("normalizeBrandName", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeBrandName("  Benro   Tripod  ")).toBe("benro tripod");
    expect(normalizeBrandName("Manfrotto")).toBe("manfrotto");
  });

  test("normalizes non-breaking and exotic spaces", () => {
    expect(normalizeBrandName("Benro\u00a0Tripod")).toBe("benro tripod");
  });

  test("lowercases for deduplication", () => {
    expect(normalizeBrandName("BENRO")).toBe(normalizeBrandName("benro"));
    expect(normalizeBrandName("BenRo")).toBe("benro");
  });

  test("strips surrounding quotes and trailing punctuation", () => {
    expect(normalizeBrandName('"Benro"')).toBe("benro");
    expect(normalizeBrandName("Benro.")).toBe("benro");
  });

  test("does not aggressively rewrite internal word spacing", () => {
    expect(normalizeBrandName("A O Smith")).toBe("a o smith");
    expect(normalizeBrandName("A O Smith")).not.toBe("ao smith");
  });

  test("rejects empty and unusable values", () => {
    expect(normalizeBrandName("")).toBe("");
    expect(normalizeBrandName("   ")).toBe("");
    expect(normalizeBrandName("...")).toBe("");
    expect(normalizeBrandName("Amazon")).toBe("");
    expect(normalizeBrandName("Sponsored")).toBe("");
    expect(normalizeBrandName("Visit the Store")).toBe("");
  });

  test("rejects overlong values", () => {
    expect(normalizeBrandName("B".repeat(81))).toBe("");
  });
});

describe("isPlausibleBrandName", () => {
  test("accepts real brands", () => {
    expect(isPlausibleBrandName("Benro")).toBe(true);
    expect(isPlausibleBrandName("OnePlus")).toBe(true);
    expect(isPlausibleBrandName("A O Smith")).toBe(true);
  });

  test("rejects non-brands", () => {
    expect(isPlausibleBrandName("")).toBe(false);
    expect(isPlausibleBrandName("Amazon")).toBe(false);
    expect(isPlausibleBrandName("12345678901234")).toBe(false);
  });
});

describe("extractBrandFromByline", () => {
  test("extracts the brand from a store byline", () => {
    expect(extractBrandFromByline("Visit the Portronics Store")).toBe("Portronics");
    expect(extractBrandFromByline("Visit the OnePlus Store")).toBe("OnePlus");
  });

  test("returns empty when the byline is not a store line", () => {
    expect(extractBrandFromByline("Some other link")).toBe("");
    expect(extractBrandFromByline("")).toBe("");
  });
});

describe("isBrandLabel", () => {
  test("accepts brand labels only", () => {
    expect(isBrandLabel("Brand")).toBe(true);
    expect(isBrandLabel("Brand Name")).toBe(true);
    expect(isBrandLabel("Manufacturer")).toBe(true);
    expect(isBrandLabel("Best Sellers Rank")).toBe(false);
    expect(isBrandLabel("Department")).toBe(false);
  });
});
