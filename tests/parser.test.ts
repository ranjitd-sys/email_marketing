import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCategoryPage } from "../src/category/parser";

const FIXTURES = join(import.meta.dir, "fixtures");

async function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text();
}

const ROOT_URL = "https://www.amazon.in/gp/bestsellers/";
const ELECTRONICS_URL = "https://www.amazon.in/gp/bestsellers/electronics/";

describe("parseCategoryPage", () => {
  test("extracts direct children from the live root fixture", async () => {
    const result = parseCategoryPage(await fixture("root.html"), ROOT_URL);
    expect(result.navTreePresent).toBe(true);
    expect(result.categories.length).toBeGreaterThan(10);

    const books = result.categories.find((c) => c.name === "Books");
    expect(books?.url).toBe("https://www.amazon.in/gp/bestsellers/books/");
  });

  test("extracts children from the electronics fixture", async () => {
    const result = parseCategoryPage(await fixture("electronics.html"), ELECTRONICS_URL);
    expect(result.navTreePresent).toBe(true);
    const names = result.categories.map((c) => c.name);
    expect(names).toContain("Headphones");
    expect(result.categories.every((c) => c.url.startsWith(ELECTRONICS_URL))).toBe(true);
  });

  test("filters ancestors, self links, duplicates and decoys", async () => {
    const result = parseCategoryPage(await fixture("decoys.html"), ELECTRONICS_URL);
    expect(result.navTreePresent).toBe(true);

    const urls = result.categories.map((c) => c.url).sort();
    expect(urls).toEqual([
      "https://www.amazon.in/gp/bestsellers/electronics/1388921031/",
      "https://www.amazon.in/gp/bestsellers/electronics/1388977031/",
    ]);
    expect(result.categories.map((c) => c.name)).not.toContain("External");
    expect(result.categories.map((c) => c.name)).not.toContain("Self");
  });

  test("reports navTreePresent=false when the nav tree is absent", async () => {
    const result = parseCategoryPage(await fixture("no-nav.html"), ROOT_URL);
    expect(result.navTreePresent).toBe(false);
    expect(result.categories).toEqual([]);
  });

  test("throws when currentUrl is not a category URL", async () => {
    const html = await fixture("root.html");
    expect(() => parseCategoryPage(html, "https://www.amazon.in/dp/B0EXAMPLE01")).toThrow();
  });
});
