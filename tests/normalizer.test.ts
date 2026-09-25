import { describe, expect, test } from "bun:test";
import { isCategoryUrl, normalizeCategoryUrl } from "../src/category/normalizer";

describe("normalizeCategoryUrl", () => {
  test("canonicalizes the root", () => {
    expect(normalizeCategoryUrl("https://www.amazon.in/gp/bestsellers/")).toBe(
      "https://www.amazon.in/gp/bestsellers/"
    );
    expect(normalizeCategoryUrl("https://www.amazon.in/gp/bestsellers")).toBe(
      "https://www.amazon.in/gp/bestsellers/"
    );
  });

  test("drops the /ref= tracking segment and enforces a trailing slash", () => {
    expect(
      normalizeCategoryUrl(
        "https://www.amazon.in/gp/bestsellers/electronics/ref=zg_bs_nav_electronics_1"
      )
    ).toBe("https://www.amazon.in/gp/bestsellers/electronics/");
  });

  test("drops query string and hash", () => {
    expect(
      normalizeCategoryUrl(
        "https://www.amazon.in/gp/bestsellers/electronics/?ref_=nav_cs_bestsellers&pg=2#x"
      )
    ).toBe("https://www.amazon.in/gp/bestsellers/electronics/");
  });

  test("keeps a slug + browse node id and produces no double slash", () => {
    expect(
      normalizeCategoryUrl(
        "https://www.amazon.in/gp/bestsellers/electronics/1388921031/ref=zg_bs_nav_electronics_1"
      )
    ).toBe("https://www.amazon.in/gp/bestsellers/electronics/1388921031/");
  });

  test("resolves relative hrefs against amazon.in", () => {
    expect(normalizeCategoryUrl("/gp/bestsellers/books/")).toBe(
      "https://www.amazon.in/gp/bestsellers/books/"
    );
  });

  test("is idempotent", () => {
    const once = normalizeCategoryUrl(
      "https://www.amazon.in/gp/bestsellers/electronics/ref=zg_bs_nav_electronics_1"
    );
    expect(normalizeCategoryUrl(once)).toBe(once);
  });

  test("rejects too many path segments", () => {
    expect(() =>
      normalizeCategoryUrl("https://www.amazon.in/gp/bestsellers/a/b/c/")
    ).toThrow();
  });
});

describe("isCategoryUrl", () => {
  test("accepts valid bestseller category URLs", () => {
    expect(isCategoryUrl("https://www.amazon.in/gp/bestsellers/electronics/")).toBe(true);
    expect(
      isCategoryUrl("https://www.amazon.in/gp/bestsellers/electronics/1388921031/")
    ).toBe(true);
    expect(isCategoryUrl("/gp/bestsellers/books/ref=nav_cs_bestsellers")).toBe(true);
  });

  test("rejects non-category and unsafe URLs", () => {
    const rejected = [
      "https://www.amazon.in/dp/B0EXAMPLE01",
      "https://www.amazon.in/s?k=headphones",
      "https://www.amazon.in/gp/cart/view.html",
      "https://example.com/gp/bestsellers/electronics/",
      "https://www.amazon.com/gp/bestsellers/electronics/",
      "javascript:void(0)",
      "mailto:foo@example.com",
      "",
    ];
    for (const url of rejected) {
      expect(isCategoryUrl(url)).toBe(false);
    }
  });
});
