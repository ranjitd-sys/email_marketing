import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  dedupeBrandsByNormalizedName,
  extractBrandFromProductPage,
  extractBrandResult,
  parseProductResults,
} from "../../src/brand/parser";

const FIXTURES = join(import.meta.dir, "fixtures");

async function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text();
}

describe("parseProductResults", () => {
  test("extracts product entries from a real category fixture", async () => {
    const page = parseProductResults(await fixture("category-headphones.html"));

    expect(page.products.length).toBe(30);
    const first = page.products[0];
    expect(first?.asin).toBe("B0DDHM6D3L");
    expect(first?.productUrl).toBe("https://www.amazon.in/dp/B0DDHM6D3L");
    expect(first?.rank).toBe(1);
    expect(first?.title).toContain("Portronics");
  });

  test("returns unique ASINs in rank order", async () => {
    const page = parseProductResults(await fixture("category-headphones.html"));
    const asins = page.products.map((p) => p.asin);
    expect(new Set(asins).size).toBe(asins.length);
    expect(page.products.map((p) => p.rank)).toEqual(
      page.products.map((_, index) => index + 1)
    );
  });

  test("detects the next result page", async () => {
    const page = parseProductResults(await fixture("category-headphones.html"));
    expect(page.nextPageUrl).toBe(
      "https://www.amazon.in/gp/bestsellers/electronics/1388921031/ref=zg_bs_pg_2_electronics?ie=UTF8&pg=2"
    );
  });

  test("returns no next page when pagination is absent", async () => {
    const page = parseProductResults(await fixture("category-root.html"));
    expect(page.products.length).toBe(36);
    expect(page.nextPageUrl).toBeNull();
  });

  test("returns an empty page for HTML with no products", () => {
    const page = parseProductResults("<html><body><p>nothing here</p></body></html>");
    expect(page.products).toEqual([]);
    expect(page.nextPageUrl).toBeNull();
  });
});

describe("extractBrandFromProductPage", () => {
  test("reads the explicit Brand spec row", async () => {
    const brand = extractBrandFromProductPage(await fixture("product-benro.html"));
    expect(brand).toEqual({ brand: "Benro", source: "detail_spec_brand" });
  });

  test("falls back to the store byline", async () => {
    const brand = extractBrandFromProductPage(await fixture("product-manfrotto.html"));
    expect(brand).toEqual({ brand: "Manfrotto", source: "byline_store" });
  });

  test("prefers JSON-LD structured metadata", async () => {
    const brand = extractBrandFromProductPage(await fixture("product-jsonld.html"));
    expect(brand).toEqual({ brand: "Joby", source: "json_ld_product" });
  });

  test("returns null when there is no attributable brand", async () => {
    const brand = extractBrandFromProductPage(await fixture("product-nobrand.html"));
    expect(brand).toBeNull();
  });

  test("returns null for a page that is not a product page", () => {
    expect(extractBrandFromProductPage("<html><body>Access Denied</body></html>")).toBeNull();
  });

  test("reports a reason when the brand cannot be determined", async () => {
    const result = extractBrandResult(await fixture("product-nobrand.html"), "B0DDD44444");
    expect(result.extraction).toBeNull();
    expect(result.reason).toBe("brand_metadata_empty");
  });

  test("reports non-product pages distinctly", () => {
    const result = extractBrandResult("<html><body>Robot</body></html>", "B000000000");
    expect(result.extraction).toBeNull();
    expect(result.reason).toBe("no_product_markers");
  });
});

describe("dedupeBrandsByNormalizedName", () => {
  test("collapses repeats of the same brand and keeps first-seen order", () => {
    const result = dedupeBrandsByNormalizedName([
      { brand: "Benro", source: "detail_spec_brand" },
      { brand: "Manfrotto", source: "byline_store" },
      { brand: "benro", source: "detail_spec_brand" },
      { brand: "  BENRO  ", source: "byline_store" },
    ]);

    expect(result.map((r) => r.brand)).toEqual(["Benro", "Manfrotto"]);
    expect(result.map((r) => r.normalizedName)).toEqual(["benro", "manfrotto"]);
  });

  test("drops values that cannot be normalized", () => {
    const result = dedupeBrandsByNormalizedName([
      { brand: "", source: "byline_store" },
      { brand: "Amazon", source: "byline_store" },
      { brand: "Joby", source: "json_ld_product" },
    ]);
    expect(result).toHaveLength(1);
    expect(result.at(0)?.brand).toBe("Joby");
  });
});
