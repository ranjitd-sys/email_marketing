import { afterAll, beforeAll, beforeEach, describe, expect, test as baseTest } from "bun:test";
import { join } from "node:path";
import type { Db } from "../../src/db/client";
import type { HttpClient } from "../../src/http/client";
import type { BrandConfig } from "../../src/config/env";
import { runMigrations } from "../../src/db/migrate";
import { crawlBrandBatch } from "../../src/brand/crawler";
import { dropTestSchema, recreateTestSchema, testClient } from "../helpers/testdb";

const SCHEMA = "brand_test_crawler";
const TIMEOUT = 30_000;
const test = (name: string, fn: () => Promise<void>) => baseTest(name, fn, TIMEOUT);

const FIXTURES = join(import.meta.dir, "fixtures");

async function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text();
}

const BASE_CONFIG: BrandConfig = {
  databaseUrl: "unused",
  workerId: "brand-worker-1",
  batchSize: 1,
  requestDelayMs: 0,
  requestTimeoutMs: 1_000,
  maxRetries: 0,
  brandMaxRetries: 3,
  brandLeaseTimeoutMs: 60_000,
  maxCategoryResultPages: 1,
  maxProductPagesPerCategory: 4,
  userAgent: "test",
};

let db: Db;

beforeAll(() => {
  db = testClient(SCHEMA);
});

afterAll(async () => {
  await db.end();
  await dropTestSchema(SCHEMA);
});

beforeEach(async () => {
  await recreateTestSchema(SCHEMA);
  await runMigrations(db);
});

async function seedCategory(url: string, crawlOrder = 1): Promise<number> {
  const [row] = await db`
    INSERT INTO categories (name, url, parent_id, depth, crawl_order, status, brand_status)
    VALUES (${"Tripods"}, ${url}, NULL, ${0}, ${crawlOrder}, 'COMPLETED', 'PENDING')
    RETURNING id
  `;
  return Number(row.id);
}

function fakeHttp(overrides: Record<string, string> = {}): HttpClient {
  return {
    async fetchPage(url: string): Promise<string> {
      for (const [needle, file] of Object.entries(overrides)) {
        if (url.includes(needle)) return fixture(file);
      }
      if (url.includes("/gp/bestsellers/")) return fixture("category-headphones.html");
      if (url.includes("B0DDHM6D3L")) return fixture("product-benro.html");
      if (url.includes("B0FMDL81GS")) return fixture("product-manfrotto.html");
      return fixture("product-nobrand.html");
    },
  };
}

describe("crawlBrandBatch", () => {
  test("processes a category, saves brands and marks it COMPLETED", async () => {
    const categoryId = await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/1388921031/");

    const summary = await crawlBrandBatch(db, fakeHttp(), BASE_CONFIG);

    expect(summary.processedCategories).toBe(1);
    expect(summary.failedCategories).toBe(0);
    expect(summary.uniqueBrandsDiscovered).toBeGreaterThan(0);

    const [row] = await db`
      SELECT brand_status, brand_processed_at FROM categories WHERE id = ${categoryId}
    `;
    expect(row.brand_status).toBe("COMPLETED");
    expect(row.brand_processed_at).not.toBeNull();

    const [links] = await db`
      SELECT COUNT(*)::int AS n FROM category_brands WHERE category_id = ${categoryId}
    `;
    expect(links.n).toBeGreaterThan(0);
  });

  test("a second run does not duplicate brands or relationships", async () => {
    const categoryId = await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/1388921031/");

    await crawlBrandBatch(db, fakeHttp(), BASE_CONFIG);
    const firstBrands = await db`SELECT COUNT(*)::int AS n FROM brands`;
    const firstLinks = await db`SELECT COUNT(*)::int AS n FROM category_brands`;

    await db`UPDATE categories SET brand_status = 'PENDING' WHERE id = ${categoryId}`;
    await crawlBrandBatch(db, fakeHttp(), BASE_CONFIG);

    const secondBrands = await db`SELECT COUNT(*)::int AS n FROM brands`;
    const secondLinks = await db`SELECT COUNT(*)::int AS n FROM category_brands`;

    expect(secondBrands[0].n).toBe(firstBrands[0].n);
    expect(secondLinks[0].n).toBe(firstLinks[0].n);
  });

  test("reuses one brand row across two categories", async () => {
    const a = await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/1388921031/", 1);
    const b = await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/14146389031/", 2);

    const http: HttpClient = {
      async fetchPage(url: string): Promise<string> {
        if (url.includes("/gp/bestsellers/")) return fixture("category-headphones.html");
        return fixture("product-benro.html");
      },
    };

    await crawlBrandBatch(db, http, { ...BASE_CONFIG, batchSize: 2 });

    const [brandCount] = await db`SELECT COUNT(*)::int AS n FROM brands`;
    const links = await db`
      SELECT category_id FROM category_brands ORDER BY category_id
    `;

    expect(brandCount.n).toBe(1);
    expect(links.map((r: { category_id: number }) => Number(r.category_id)).sort()).toEqual(
      [a, b].sort()
    );
  });

  test("keeps failed categories recoverable and retries them", async () => {
    const categoryId = await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/1388921031/");

    const failing: HttpClient = {
      async fetchPage(): Promise<string> {
        throw new Error("network down");
      },
    };

    const failedRun = await crawlBrandBatch(db, failing, BASE_CONFIG);

    expect(failedRun.processedCategories).toBe(0);
    expect(failedRun.failedCategories).toBe(1);

    const [afterFailure] = await db`
      SELECT brand_status, brand_attempts FROM categories WHERE id = ${categoryId}
    `;
    expect(afterFailure.brand_status).toBe("PENDING");
    expect(Number(afterFailure.brand_attempts)).toBe(1);

    const recovered = await crawlBrandBatch(db, fakeHttp(), BASE_CONFIG);
    expect(recovered.processedCategories).toBe(1);

    const [afterRecovery] = await db`
      SELECT brand_status FROM categories WHERE id = ${categoryId}
    `;
    expect(afterRecovery.brand_status).toBe("COMPLETED");
  });

  test("marks a category FAILED after the retry limit", async () => {
    const categoryId = await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/1388921031/");

    const failing: HttpClient = {
      async fetchPage(): Promise<string> {
        throw new Error("network down");
      },
    };

    for (let run = 0; run < 3; run++) {
      await crawlBrandBatch(db, failing, { ...BASE_CONFIG, brandMaxRetries: 3 });
    }

    const [row] = await db`
      SELECT brand_status, brand_attempts FROM categories WHERE id = ${categoryId}
    `;
    expect(row.brand_status).toBe("FAILED");
    expect(Number(row.brand_attempts)).toBe(3);
  });

  test("continues with the next pending category in crawl_order", async () => {
    const first = await seedCategory("https://www.amazon.in/gp/bestsellers/a/", 1);
    const second = await seedCategory("https://www.amazon.in/gp/bestsellers/b/", 2);

    const firstRun = await crawlBrandBatch(db, fakeHttp(), BASE_CONFIG);
    expect(firstRun.lastProcessedCrawlOrder).toBe(1);

    const [firstRow] = await db`SELECT brand_status FROM categories WHERE id = ${first}`;
    const [secondRow] = await db`SELECT brand_status FROM categories WHERE id = ${second}`;
    expect(firstRow.brand_status).toBe("COMPLETED");
    expect(secondRow.brand_status).toBe("PENDING");

    const secondRun = await crawlBrandBatch(db, fakeHttp(), BASE_CONFIG);
    expect(secondRun.lastProcessedCrawlOrder).toBe(2);
    expect(secondRun.processedCategories).toBe(1);
  });

  test("respects the per-category product page budget", async () => {
    await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/1388921031/");

    const summary = await crawlBrandBatch(db, fakeHttp(), {
      ...BASE_CONFIG,
      maxProductPagesPerCategory: 2,
    });

    expect(summary.processedCategories).toBe(1);
    const [links] = await db`SELECT COUNT(*)::int AS n FROM category_brands`;
    expect(links.n).toBeLessThanOrEqual(2);
  });

  test("follows pagination up to the configured page limit", async () => {
    await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/1388921031/");

    const page2 = await fixture("category-root.html");
    const requested: string[] = [];

    const paginating: HttpClient = {
      async fetchPage(url: string): Promise<string> {
        if (url.includes("/gp/bestsellers/")) {
          requested.push(url);
          if (url.includes("pg=2")) return page2;
          return fixture("category-headphones.html");
        }
        return fixture("product-benro.html");
      },
    };

    await crawlBrandBatch(db, paginating, {
      ...BASE_CONFIG,
      maxCategoryResultPages: 2,
      maxProductPagesPerCategory: 40,
    });

    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain("pg=2");
  });

  test("reports a summary with remaining pending categories", async () => {
    await seedCategory("https://www.amazon.in/gp/bestsellers/a/", 1);
    await seedCategory("https://www.amazon.in/gp/bestsellers/b/", 2);

    const summary = await crawlBrandBatch(db, fakeHttp(), BASE_CONFIG);

    expect(summary.brandCategoriesPending).toBe(1);
    expect(summary.brandCategoriesCompleted).toBe(1);
    expect(summary.brandCategoriesFailed).toBe(0);
    expect(summary.brandsDiscoveredTotal).toBeGreaterThan(0);
    expect(summary.categoryBrandRelationshipsTotal).toBe(summary.relationshipsCreated);
  });

  test("does not persist products or sellers", async () => {
    await seedCategory("https://www.amazon.in/gp/bestsellers/electronics/1388921031/");
    await crawlBrandBatch(db, fakeHttp(), BASE_CONFIG);

    const tables = await db`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
    `;
    const names = tables.map((r: { table_name: string }) => r.table_name);

    expect(names).toContain("brands");
    expect(names).toContain("category_brands");

    const [counts] = await db`
      SELECT
        (SELECT COUNT(*)::int FROM products) AS products,
        (SELECT COUNT(*)::int FROM sellers) AS sellers
    `;
    expect(counts.products).toBe(0);
    expect(counts.sellers).toBe(0);
  });
});
