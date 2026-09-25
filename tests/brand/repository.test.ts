import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import {
  claimBrandCategories,
  getBrandCrawlStateCounts,
  markBrandCategoryFailure,
  persistBrandCrawl,
  resetFailedBrandCategories,
  upsertBrand,
} from "../../src/brand/repository";
import { dropTestSchema, recreateTestSchema, testClient } from "../helpers/testdb";

const SCHEMA = "brand_test_repository";
const TIMEOUT = 30_000;

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

async function seedCategories(urls: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const [index, url] of urls.entries()) {
    const [row] = await db`
      INSERT INTO categories (name, url, parent_id, depth, crawl_order, status, brand_status)
      VALUES (
        ${`Category ${index + 1}`},
        ${url},
        NULL,
        ${0},
        ${index + 1},
        'COMPLETED',
        'PENDING'
      )
      RETURNING id
    `;
    ids.push(Number(row.id));
  }
  return ids;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

const OPTIONS = {
  batchSize: 2,
  leaseTimeoutMs: 60_000,
  maxAttempts: 3,
  workerId: "brand-worker-test",
};

describe("claimBrandCategories", () => {
  test("claims PENDING categories in crawl_order and locks them", async () => {
    const ids = await seedCategories([
      "https://www.amazon.in/gp/bestsellers/a/",
      "https://www.amazon.in/gp/bestsellers/b/",
      "https://www.amazon.in/gp/bestsellers/c/",
    ]);

    const claim = await claimBrandCategories(db, OPTIONS);

    expect(claim.claimed).toHaveLength(2);
    expect(claim.claimed.map((c) => c.categoryId)).toEqual([
      required(ids[0], "first id"),
      required(ids[1], "second id"),
    ]);
    expect(claim.claimed.every((c) => c.brandStatus === "PROCESSING")).toBe(true);
    expect(claim.claimed.every((c) => c.claimOrigin === "pending")).toBe(true);
    expect(claim.claimed.at(0)?.brandAttempts).toBe(1);
    expect(claim.reclaimed).toBe(0);

    const [locked] = await db`
      SELECT brand_locked_by FROM categories WHERE id = ${required(ids[0], 'category id')}
    `;
    expect(locked.brand_locked_by).toBe("brand-worker-test");
  });

  test("never hands the same category to two workers", async () => {
    await seedCategories([
      "https://www.amazon.in/gp/bestsellers/a/",
      "https://www.amazon.in/gp/bestsellers/b/",
      "https://www.amazon.in/gp/bestsellers/c/",
    ]);

    const first = await claimBrandCategories(db, OPTIONS);
    const second = await claimBrandCategories(db, { ...OPTIONS, workerId: "brand-worker-two" });

    const firstIds = first.claimed.map((c) => c.categoryId);
    const secondIds = second.claimed.map((c) => c.categoryId);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  test("respects the batch size", async () => {
    await seedCategories([
      "https://www.amazon.in/gp/bestsellers/a/",
      "https://www.amazon.in/gp/bestsellers/b/",
      "https://www.amazon.in/gp/bestsellers/c/",
    ]);

    const claim = await claimBrandCategories(db, { ...OPTIONS, batchSize: 1 });
    expect(claim.claimed).toHaveLength(1);
  });

  test("reclaims PROCESSING work whose lease expired", async () => {
    const ids = await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"]);
    await claimBrandCategories(db, OPTIONS);

    const fresh = await claimBrandCategories(db, OPTIONS);
    expect(fresh.claimed).toHaveLength(0);

    await db`
      UPDATE categories
      SET brand_locked_at = NOW() - INTERVAL '2 hours'
      WHERE id = ${required(ids[0], 'category id')}
    `;

    const reclaimed = await claimBrandCategories(db, {
      ...OPTIONS,
      workerId: "brand-worker-two",
      leaseTimeoutMs: 60_000,
    });

    expect(reclaimed.claimed).toHaveLength(1);
    expect(reclaimed.claimed.at(0)?.categoryId).toBe(required(ids[0], "category id"));
    expect(reclaimed.claimed.at(0)?.claimOrigin).toBe("reclaimed");
    expect(reclaimed.reclaimed).toBe(1);
  });

  test("marks exhausted categories FAILED instead of reclaiming forever", async () => {
    const ids = await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"]);

    await db`
      UPDATE categories
      SET brand_status = 'PROCESSING', brand_attempts = 3, brand_locked_at = NOW() - INTERVAL '2 hours'
      WHERE id = ${required(ids[0], 'category id')}
    `;

    const claim = await claimBrandCategories(db, OPTIONS);

    expect(claim.claimed).toHaveLength(0);
    expect(claim.exhaustedMarkedFailed).toBe(1);

    const [row] = await db`
      SELECT brand_status FROM categories WHERE id = ${required(ids[0], 'category id')}
    `;
    expect(row.brand_status).toBe("FAILED");
  });
});

describe("upsertBrand", () => {
  test("creates a brand once and reuses the row afterwards", async () => {
    const first = await upsertBrand(db, { name: "Benro", normalizedName: "benro" });
    expect(first.isNew).toBe(true);
    expect(first.brand.name).toBe("Benro");

    const second = await upsertBrand(db, { name: "BENRO", normalizedName: "benro" });
    expect(second.isNew).toBe(false);
    expect(second.brand.id).toBe(first.brand.id);
    expect(second.brand.name).toBe("Benro");

    const [count] = await db`SELECT COUNT(*)::int AS n FROM brands`;
    expect(count.n).toBe(1);
  });
});

describe("persistBrandCrawl", () => {
  test("links brands to a category and marks it COMPLETED", async () => {
    const ids = await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"]);
    const categoryId = required(ids[0], "category id");
    await claimBrandCategories(db, OPTIONS);

    const result = await persistBrandCrawl(db, {
      categoryId,
      brands: [
        { name: "Benro", normalizedName: "benro" },
        { name: "Manfrotto", normalizedName: "manfrotto" },
      ],
      workerId: OPTIONS.workerId,
    });

    expect(result.relationshipsCreated).toBe(2);
    expect(result.brandIds).toHaveLength(2);

    const [row] = await db`
      SELECT brand_status, brand_locked_by, brand_locked_at, brand_processed_at
      FROM categories WHERE id = ${categoryId}
    `;
    expect(row.brand_status).toBe("COMPLETED");
    expect(row.brand_locked_by).toBeNull();
    expect(row.brand_locked_at).toBeNull();
    expect(row.brand_processed_at).not.toBeNull();
  });

  test("is idempotent when the same category is processed again", async () => {
    const categoryId = required(
      (await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"])).at(0),
      "category id"
    );
    const brands = [{ name: "Benro", normalizedName: "benro" }];

    await claimBrandCategories(db, OPTIONS);
    await persistBrandCrawl(db, { categoryId, brands, workerId: OPTIONS.workerId });

    await db`UPDATE categories SET brand_status = 'PENDING' WHERE id = ${categoryId}`;
    await claimBrandCategories(db, OPTIONS);
    const second = await persistBrandCrawl(db, {
      categoryId,
      brands,
      workerId: OPTIONS.workerId,
    });

    expect(second.relationshipsCreated).toBe(0);

    const [brands1, links] = await Promise.all([
      db`SELECT COUNT(*)::int AS n FROM brands`,
      db`SELECT COUNT(*)::int AS n FROM category_brands`,
    ]);
    expect(brands1[0].n).toBe(1);
    expect(links[0].n).toBe(1);
  });

  test("keeps one brand row shared across categories", async () => {
    const seeded = await seedCategories([
      "https://www.amazon.in/gp/bestsellers/a/",
      "https://www.amazon.in/gp/bestsellers/b/",
    ]);
    const categoryA = required(seeded.at(0), "category A");
    const categoryB = required(seeded.at(1), "category B");

    await claimBrandCategories(db, OPTIONS);
    await persistBrandCrawl(db, {
      categoryId: categoryA,
      brands: [
        { name: "Benro", normalizedName: "benro" },
        { name: "Manfrotto", normalizedName: "manfrotto" },
      ],
      workerId: OPTIONS.workerId,
    });

    await claimBrandCategories(db, OPTIONS);
    await persistBrandCrawl(db, {
      categoryId: categoryB,
      brands: [
        { name: "Benro", normalizedName: "benro" },
        { name: "Joby", normalizedName: "joby" },
      ],
      workerId: OPTIONS.workerId,
    });

    const [brandCount, linkRows] = await Promise.all([
      db`SELECT COUNT(*)::int AS n FROM brands`,
      db`SELECT category_id, brand_id FROM category_brands ORDER BY category_id, brand_id`,
    ]);

    expect(brandCount[0].n).toBe(3);

    const benro = await db`SELECT id FROM brands WHERE normalized_name = 'benro'`;
    const benroId = Number(benro[0].id);
    const linksForBenro = linkRows.filter((r: { brand_id: number }) => Number(r.brand_id) === benroId);
    expect(linksForBenro).toHaveLength(2);
  });

  test("refuses to complete a category whose lease was lost", async () => {
    const categoryId = required(
      (await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"])).at(0),
      "category id"
    );
    await claimBrandCategories(db, OPTIONS);

    await expect(
      persistBrandCrawl(db, {
        categoryId,
        brands: [{ name: "Benro", normalizedName: "benro" }],
        workerId: "brand-worker-not-owner",
      })
    ).rejects.toThrow(/lease is no longer held/);

    const [row] = await db`SELECT brand_status FROM categories WHERE id = ${categoryId}`;
    expect(row.brand_status).toBe("PROCESSING");
  });
});

describe("markBrandCategoryFailure", () => {
  test("returns work to PENDING while attempts remain", async () => {
    const categoryId = required(
      (await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"])).at(0),
      "category id"
    );
    await claimBrandCategories(db, OPTIONS);

    const failure = await markBrandCategoryFailure(db, {
      categoryId,
      workerId: OPTIONS.workerId,
      maxAttempts: 3,
      error: "boom",
    });

    expect(failure.status).toBe("PENDING");
    expect(failure.attempts).toBe(1);

    const [row] = await db`SELECT brand_locked_by FROM categories WHERE id = ${categoryId}`;
    expect(row.brand_locked_by).toBeNull();
  });

  test("marks FAILED once the retry limit is reached", async () => {
    const categoryId = required(
      (await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"])).at(0),
      "category id"
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      await claimBrandCategories(db, OPTIONS);
      await markBrandCategoryFailure(db, {
        categoryId,
        workerId: OPTIONS.workerId,
        maxAttempts: 3,
        error: "boom",
      });
    }

    const [row] = await db`
      SELECT brand_status, brand_attempts FROM categories WHERE id = ${categoryId}
    `;
    expect(row.brand_status).toBe("FAILED");
    expect(row.brand_attempts).toBe(3);
  });

  test("leaves other workers' work untouched", async () => {
    const categoryId = required(
      (await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"])).at(0),
      "category id"
    );
    await claimBrandCategories(db, OPTIONS);

    const failure = await markBrandCategoryFailure(db, {
      categoryId,
      workerId: "brand-worker-not-owner",
      maxAttempts: 3,
      error: "boom",
    });

    expect(failure.status).toBe("PROCESSING");
  });

  test("resetFailedBrandCategories makes FAILED work recoverable", async () => {
    const categoryId = required(
      (await seedCategories(["https://www.amazon.in/gp/bestsellers/a/"])).at(0),
      "category id"
    );
    await db`UPDATE categories SET brand_status = 'FAILED', brand_attempts = 3 WHERE id = ${categoryId}`;

    const reset = await resetFailedBrandCategories(db);
    expect(reset).toBe(1);

    const [row] = await db`
      SELECT brand_status, brand_attempts FROM categories WHERE id = ${categoryId}
    `;
    expect(row.brand_status).toBe("PENDING");
    expect(row.brand_attempts).toBe(0);
  });
});

describe("getBrandCrawlStateCounts", () => {
  test("counts categories by brand_status", async () => {
    await seedCategories([
      "https://www.amazon.in/gp/bestsellers/a/",
      "https://www.amazon.in/gp/bestsellers/b/",
      "https://www.amazon.in/gp/bestsellers/c/",
    ]);
    await db`UPDATE categories SET brand_status = 'COMPLETED' WHERE crawl_order = 1`;
    await db`UPDATE categories SET brand_status = 'FAILED' WHERE crawl_order = 2`;

    const counts = await getBrandCrawlStateCounts(db);

    expect(counts.totalCategories).toBe(3);
    expect(counts.completedCategories).toBe(1);
    expect(counts.failedCategories).toBe(1);
    expect(counts.pendingCategories).toBe(1);
  });
});
