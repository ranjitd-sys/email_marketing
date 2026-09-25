import { afterAll, beforeAll, beforeEach, describe, expect, test as baseTest } from "bun:test";
import type { Db } from "../src/db/client";
import {
  claimNextBatch,
  completeCategory,
  getCrawlSummary,
  initializeCategories,
  ROOT_CATEGORY_URL,
  saveCategory,
} from "../src/category/repository";
import { dropTestSchema, recreateTestSchema, testClient } from "./helpers/testdb";

const SCHEMA = "categories_test_repository";
const TIMEOUT = 20_000;
const test = (name: string, fn: () => Promise<void>) => baseTest(name, fn, TIMEOUT);

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
  await initializeCategories(db);
});

describe("initializeCategories", () => {
  test("seeds the root exactly once and is idempotent", async () => {
    const first = await initializeCategories(db);
    const second = await initializeCategories(db);

    expect(first.root.url).toBe(ROOT_CATEGORY_URL);
    expect(first.root.crawlOrder).toBe(1);
    expect(first.root.status).toBe("PENDING");
    expect(second.root.id).toBe(first.root.id);

    const [row] = await db`
      SELECT COUNT(*)::int AS n FROM categories WHERE url = ${ROOT_CATEGORY_URL}
    `;
    expect(row.n).toBe(1);
  });
});

describe("saveCategory", () => {
  test("inserts a new child with parent/depth/crawl_order and dedupes on url", async () => {
    const { root } = await initializeCategories(db);

    const first = await saveCategory(db, {
      name: "Electronics",
      url: "https://www.amazon.in/gp/bestsellers/electronics/",
      parentId: root.id,
      depth: root.depth + 1,
    });
    expect(first.isNew).toBe(true);
    expect(first.record.parentId).toBe(root.id);
    expect(first.record.depth).toBe(1);
    expect(first.record.crawlOrder).toBeGreaterThan(1);

    const again = await saveCategory(db, {
      name: "Electronics (renamed)",
      url: "https://www.amazon.in/gp/bestsellers/electronics/",
      parentId: root.id,
      depth: root.depth + 1,
    });
    expect(again.isNew).toBe(false);
    expect(again.record.id).toBe(first.record.id);
    expect(again.record.name).toBe("Electronics");
  });
});

describe("claimNextBatch", () => {
  test("claims PENDING rows in crawl_order and marks them PROCESSING", async () => {
    const { root } = await initializeCategories(db);
    const child = await saveCategory(db, {
      name: "Books",
      url: "https://www.amazon.in/gp/bestsellers/books/",
      parentId: root.id,
      depth: 1,
    });

    const claimed = await claimNextBatch(db, 10, 60_000);
    const urls = claimed.map((c) => c.url);
    expect(urls).toContain(ROOT_CATEGORY_URL);
    expect(urls).toContain(child.record.url);
    expect(claimed.every((c) => c.status === "PROCESSING")).toBe(true);

    const second = await claimNextBatch(db, 10, 60_000);
    expect(second).toEqual([]);
  });

  test("reclaims stale PROCESSING rows but not fresh ones", async () => {
    await initializeCategories(db);
    await claimNextBatch(db, 10, 60_000);

    const fresh = await claimNextBatch(db, 10, 60_000);
    expect(fresh).toEqual([]);

    await db`
      UPDATE categories SET processing_started_at = NOW() - INTERVAL '2 hours'
    `;
    const reclaimed = await claimNextBatch(db, 10, 60_000);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed.at(0)?.url).toBe(ROOT_CATEGORY_URL);
  });
});

describe("getCrawlSummary", () => {
  test("counts categories by status and tracks the last completed crawl_order", async () => {
    const { root } = await initializeCategories(db);
    await saveCategory(db, {
      name: "Books",
      url: "https://www.amazon.in/gp/bestsellers/books/",
      parentId: root.id,
      depth: 1,
    });
    await completeCategory(db, root.id);

    const summary = await getCrawlSummary(db);
    expect(summary.totalCount).toBe(2);
    expect(summary.completedCount).toBe(1);
    expect(summary.pendingCount).toBe(1);
    expect(summary.remainingPendingCount).toBe(1);
    expect(summary.lastProcessedCrawlOrder).toBe(1);
  });
});
