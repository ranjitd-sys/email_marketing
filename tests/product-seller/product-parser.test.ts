import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseDiscoveryPage } from "../../src/product-seller/product-discovery";
import { parseProductPage } from "../../src/product-seller/product-parser";

const FIXTURES = join(import.meta.dir, "fixtures");

async function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text();
}

describe("parseDiscoveryPage", () => {
  test("extracts ASINs from search result cards", async () => {
    const page = parseDiscoveryPage(await fixture("search-results.html"));
    expect(page.products.map((p) => p.asin)).toEqual([
      "B004TRPV3G",
      "B005BY9PPQ",
      "B00829NULW",
    ]);
    expect(page.products[0]?.url).toBe("https://www.amazon.in/dp/B004TRPV3G/");
    expect(page.products[0]?.title).toBe("Benro T660EX Photo and Video Tripod Aluminium");
  });

  test("detects the next result page", async () => {
    const page = parseDiscoveryPage(await fixture("search-results.html"));
    expect(page.nextPageUrl).toContain("page=2");
  });

  test("returns no products and no next page when there are no results", async () => {
    const page = parseDiscoveryPage(await fixture("no-products.html"));
    expect(page.products).toEqual([]);
    expect(page.nextPageUrl).toBeNull();
  });
});

describe("parseProductPage", () => {
  test("extracts product fields without fabricating values", async () => {
    const product = parseProductPage(
      await fixture("product.html"),
      "https://www.amazon.in/dp/B004TRPV3G/"
    );

    expect(product).not.toBeNull();
    expect(product?.asin).toBe("B004TRPV3G");
    expect(product?.title).toBe("Benro T660EX Photo and Video Tripod Aluminium");
    expect(product?.brand).toBe("Benro");
    expect(product?.price).toBe(1999);
    expect(product?.mrp).toBe(3500);
    expect(product?.discount).toBe(43);
    expect(product?.rating).toBe(4.2);
    expect(product?.reviewCount).toBe(148);
    expect(product?.availability).toBe("In stock");
    expect(product?.modelNumber).toBe("T660EX");
    expect(product?.manufacturer).toBe("Benro, Benro Precision");
    expect(product?.features).toHaveLength(2);
    expect(product?.images.length).toBeGreaterThan(0);
  });

  test("prefers the URL ASIN over unrelated page markers", () => {
    const html = `
      <html><body>
        <span id="productTitle">Some Product</span>
        <div data-asin="B000WRONG1">recommendation</div>
      </body></html>`;
    const product = parseProductPage(html, "https://www.amazon.in/dp/B004TRPV3G/");
    expect(product?.asin).toBe("B004TRPV3G");
  });

  test("returns null when there is no product identity or marker", () => {
    expect(parseProductPage("<html><body>Access Denied</body></html>", "https://www.amazon.in/s?k=x")).toBeNull();
    expect(parseProductPage("", "https://www.amazon.in/dp/B004TRPV3G/")).toBeNull();
  });

  test("leaves missing fields null instead of inventing them", () => {
    const html = `<html><body><span id="productTitle">Minimal Product</span></body></html>`;
    const product = parseProductPage(html, "https://www.amazon.in/dp/B004TRPV3G/");
    expect(product?.price).toBeNull();
    expect(product?.rating).toBeNull();
    expect(product?.manufacturer).toBeNull();
    expect(product?.description).toBeNull();
  });
});
