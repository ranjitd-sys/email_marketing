import { afterAll, beforeAll, beforeEach, describe, expect, test as baseTest } from "bun:test";
import { join } from "node:path";
import type { Db } from "../../src/db/client";
import type { HttpClient } from "../../src/http/client";
import type { ProductSellerConfig } from "../../src/config/env";
import { runMigrations } from "../../src/db/migrate";
import { crawlProductSellerBatch } from "../../src/product-seller/crawler";
import { dropTestSchema, recreateTestSchema, testClient } from "../helpers/testdb";

const SCHEMA = "ps_test_crawler";
const TIMEOUT = 40_000;
const test = (name: string, fn: () => Promise<void>) => baseTest(name, fn, TIMEOUT);

const FIXTURES = join(import.meta.dir, "fixtures");

async function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text();
}

const CONFIG: ProductSellerConfig = {
  databaseUrl: "unused",
  workerId: "ps-worker-1",
  batchSize: 1,
  requestDelayMs: 0,
  requestTimeoutMs: 1_000,
  maxRetries: 0,
  maxConcurrency: 2,
  maxResultPages: 3,
  maxProductsPerWork: 10,
  sellerMaxRetries: 3,
  sellerLeaseTimeoutMs: 60_000,
  fetchSellerProfiles: true,
  maxSellerProfilesPerWork: 5,
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

async function seedWork(categoryName: string, brandName: string, order: number): Promise<{ categoryId: number; brandId: number }> {
  const [category] = await db`
    INSERT INTO categories (name, url, parent_id, depth, crawl_order)
    VALUES (${categoryName}, ${`https://www.amazon.in/gp/bestsellers/${order}/`}, NULL, 0, ${order})
    RETURNING id
  `;
  const [brand] = await db`
    INSERT INTO brands (name, normalized_name)
    VALUES (${brandName}, ${brandName.toLowerCase()})
    ON CONFLICT (normalized_name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const categoryId = Number(category.id);
  const brandId = Number(brand.id);
  await db`INSERT INTO category_brands (category_id, brand_id) VALUES (${categoryId}, ${brandId})`;
  return { categoryId, brandId };
}

function fakeHttp(): HttpClient {
  return {
    async fetchPage(url: string): Promise<string> {
      if (url.includes("/s?k=") && url.includes("page=2")) return fixture("no-products.html");
      if (url.includes("/s?k=")) return fixture("search-results.html");
      if (url.includes("/sp?seller=")) return fixture("seller-profile.html");
      if (url.includes("B004TRPV3G")) return fixture("product-with-contacts.html");
      if (url.includes("/dp/")) return fixture("product.html");
      return "<html><body></body></html>";
    },
  };
}

describe("crawlProductSellerBatch", () => {
  test("discovers products, sellers, links and contacts for a category-brand", async () => {
    const work = await seedWork("Tripods", "Benro", 1);

    const summary = await crawlProductSellerBatch(db, fakeHttp(), CONFIG);

    expect(summary.processedCategoryBrandCount).toBe(1);
    expect(summary.failedCount).toBe(0);
    expect(summary.productsDiscovered).toBe(3);
    expect(summary.uniqueProducts).toBe(3);
    expect(summary.uniqueSellers).toBe(1);
    expect(summary.sellerProductRelationships).toBe(3);

    const [status] = await db`
      SELECT product_seller_status, product_seller_processed_at
      FROM category_brands WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(status.product_seller_status).toBe("COMPLETED");
    expect(status.product_seller_processed_at).not.toBeNull();

    const counts = await db`
      SELECT
        (SELECT COUNT(*)::int FROM products) AS products,
        (SELECT COUNT(*)::int FROM category_products) AS category_products,
        (SELECT COUNT(*)::int FROM brand_products) AS brand_products,
        (SELECT COUNT(*)::int FROM sellers) AS sellers,
        (SELECT COUNT(*)::int FROM seller_products) AS seller_products
    `;
    expect(counts[0].products).toBe(3);
    expect(counts[0].category_products).toBe(3);
    expect(counts[0].brand_products).toBe(3);
    expect(counts[0].sellers).toBe(1);
    expect(counts[0].seller_products).toBe(3);
  });

  test("classifies manufacturer contacts as MANUFACTURER and seller contacts as SELLER", async () => {
    await seedWork("Tripods", "Benro", 1);
    await crawlProductSellerBatch(db, fakeHttp(), CONFIG);

    const manufacturer = await db`
      SELECT entity_type, seller_id FROM contacts WHERE normalized_value = 'support@benro-manufacturer.example'
    `;
    expect(manufacturer[0].entity_type).toBe("MANUFACTURER");
    expect(manufacturer[0].seller_id).toBeNull();

    const sellerContact = await db`
      SELECT entity_type, seller_id FROM contacts WHERE normalized_value = 'seller-support@shutterbug.example'
    `;
    expect(sellerContact[0].entity_type).toBe("SELLER");
    expect(sellerContact[0].seller_id).not.toBeNull();

    const sellerCount = await db`SELECT COUNT(*)::int AS n FROM contacts WHERE entity_type = 'SELLER'`;
    expect(sellerCount[0].n).toBe(3);
  });

  test("stores the same product only once globally and reuses it across categories", async () => {
    const first = await seedWork("Tripods", "Benro", 1);
    const second = await seedWork("Camera Accessories", "Benro", 2);

    await crawlProductSellerBatch(db, fakeHttp(), { ...CONFIG, batchSize: 2 });

    const [products] = await db`SELECT COUNT(*)::int AS n FROM products`;
    expect(products.n).toBe(3);

    const rows = await db`
      SELECT category_id, COUNT(*)::int AS n FROM category_products GROUP BY category_id ORDER BY category_id
    `;
    expect(rows.map((r: { category_id: number; n: number }) => Number(r.category_id)).sort()).toEqual(
      [first.categoryId, second.categoryId].sort()
    );
    expect(rows.every((r: { n: number }) => r.n === 3)).toBe(true);
  });

  test("is idempotent when the same work is processed twice", async () => {
    const work = await seedWork("Tripods", "Benro", 1);
    await crawlProductSellerBatch(db, fakeHttp(), CONFIG);

    const before = await db`
      SELECT
        (SELECT COUNT(*)::int FROM products) AS products,
        (SELECT COUNT(*)::int FROM sellers) AS sellers,
        (SELECT COUNT(*)::int FROM category_products) AS category_products,
        (SELECT COUNT(*)::int FROM seller_products) AS seller_products,
        (SELECT COUNT(*)::int FROM contacts) AS contacts
    `;

    await db`
      UPDATE category_brands SET product_seller_status = 'PENDING', product_seller_attempts = 0
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    await crawlProductSellerBatch(db, fakeHttp(), CONFIG);

    const after = await db`
      SELECT
        (SELECT COUNT(*)::int FROM products) AS products,
        (SELECT COUNT(*)::int FROM sellers) AS sellers,
        (SELECT COUNT(*)::int FROM category_products) AS category_products,
        (SELECT COUNT(*)::int FROM seller_products) AS seller_products,
        (SELECT COUNT(*)::int FROM contacts) AS contacts
    `;
    expect(after[0]).toEqual(before[0]);
  });

  test("continues with the next work item and leaves the rest pending", async () => {
    const first = await seedWork("Tripods", "Benro", 1);
    const second = await seedWork("Tripods", "Manfrotto", 2);

    const run1 = await crawlProductSellerBatch(db, fakeHttp(), CONFIG);
    expect(run1.processedCategoryBrandCount).toBe(1);

    const states = await db`
      SELECT category_id, brand_id, product_seller_status FROM category_brands ORDER BY category_id, brand_id
    `;
    const firstState = states.find(
      (r: { category_id: number; brand_id: number }) =>
        Number(r.category_id) === first.categoryId && Number(r.brand_id) === first.brandId
    );
    const secondState = states.find(
      (r: { category_id: number; brand_id: number }) =>
        Number(r.category_id) === second.categoryId && Number(r.brand_id) === second.brandId
    );
    expect(firstState?.product_seller_status).toBe("COMPLETED");
    expect(secondState?.product_seller_status).toBe("PENDING");

    const run2 = await crawlProductSellerBatch(db, fakeHttp(), CONFIG);
    expect(run2.processedCategoryBrandCount).toBe(1);
  });

  test("keeps failed work recoverable and retries it", async () => {
    const work = await seedWork("Tripods", "Benro", 1);

    const failing: HttpClient = {
      async fetchPage(): Promise<string> {
        throw new Error("network down");
      },
    };

    const failed = await crawlProductSellerBatch(db, failing, CONFIG);
    expect(failed.processedCategoryBrandCount).toBe(0);
    expect(failed.failedCount).toBe(1);

    const [afterFailure] = await db`
      SELECT product_seller_status, product_seller_attempts
      FROM category_brands WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(afterFailure.product_seller_status).toBe("PENDING");
    expect(Number(afterFailure.product_seller_attempts)).toBe(1);

    const recovered = await crawlProductSellerBatch(db, fakeHttp(), CONFIG);
    expect(recovered.processedCategoryBrandCount).toBe(1);

    const [afterRecovery] = await db`
      SELECT product_seller_status FROM category_brands
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(afterRecovery.product_seller_status).toBe("COMPLETED");
  });

  test("marks work FAILED after the retry limit", async () => {
    const work = await seedWork("Tripods", "Benro", 1);

    const failing: HttpClient = {
      async fetchPage(): Promise<string> {
        throw new Error("network down");
      },
    };

    for (let run = 0; run < 3; run++) {
      await crawlProductSellerBatch(db, failing, CONFIG);
    }

    const [row] = await db`
      SELECT product_seller_status, product_seller_attempts
      FROM category_brands WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(row.product_seller_status).toBe("FAILED");
    expect(Number(row.product_seller_attempts)).toBe(3);
  });

  test("does not create product or seller rows for a work item that fails", async () => {
    await seedWork("Tripods", "Benro", 1);
    const failing: HttpClient = {
      async fetchPage(): Promise<string> {
        throw new Error("network down");
      },
    };
    await crawlProductSellerBatch(db, failing, CONFIG);

    const [counts] = await db`
      SELECT
        (SELECT COUNT(*)::int FROM products) AS products,
        (SELECT COUNT(*)::int FROM sellers) AS sellers
    `;
    expect(counts.products).toBe(0);
    expect(counts.sellers).toBe(0);
  });

  test("reports remaining pending work in the summary", async () => {
    await seedWork("Tripods", "Benro", 1);
    await seedWork("Tripods", "Manfrotto", 2);

    const summary = await crawlProductSellerBatch(db, fakeHttp(), CONFIG);
    expect(summary.remainingPendingWork).toBe(1);
    expect(summary.completedWork).toBe(1);
    expect(summary.pendingWork).toBe(1);
  });
});
