import { afterAll, beforeAll, beforeEach, describe, expect, test as baseTest } from "bun:test";
import { join } from "node:path";
import type { Db } from "../src/db/client";
import type { CrawlConfig } from "../src/config/env";
import type { HttpClient } from "../src/http/client";
import { crawlBatch } from "../src/category/crawler";
import { initializeCategories, ROOT_CATEGORY_URL } from "../src/category/repository";
import { dropTestSchema, recreateTestSchema, testClient } from "./helpers/testdb";

const SCHEMA = "categories_test_crawler";
const TIMEOUT = 30_000;
const test = (name: string, fn: () => Promise<void>) => baseTest(name, fn, TIMEOUT);

const FIXTURES = join(import.meta.dir, "fixtures");

async function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text();
}

const config: CrawlConfig = {
  databaseUrl: "unused",
  startUrl: ROOT_CATEGORY_URL,
  rootName: "Amazon Best Sellers",
  batchSize: 1,
  requestDelayMs: 0,
  requestTimeoutMs: 1_000,
  maxRetries: 0,
  staleProcessingTimeoutMs: 60_000,
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
  await initializeCategories(db);
});

function fixtureHttp(): HttpClient {
  return {
    async fetchPage(url: string): Promise<string> {
      if (url === ROOT_CATEGORY_URL) return fixture("root.html");
      if (url.includes("/electronics/")) return fixture("electronics.html");
      return fixture("no-nav.html");
    },
  };
}

describe("crawlBatch", () => {
  test("processes the root, discovers children and completes it", async () => {
    const result = await crawlBatch(db, fixtureHttp(), config);

    expect(result.processedCount).toBe(1);
    expect(result.discoveredCount).toBeGreaterThan(10);
    expect(result.failedCount).toBe(0);

    const [root] = await db`
      SELECT status FROM categories WHERE url = ${ROOT_CATEGORY_URL}
    `;
    expect(root.status).toBe("COMPLETED");

    const [child] = await db`
      SELECT name, depth, parent_id FROM categories
      WHERE url = 'https://www.amazon.in/gp/bestsellers/books/'
    `;
    expect(child.name).toBe("Books");
    expect(child.depth).toBe(1);
    expect(child.parent_id).not.toBeNull();
  });

  test("continues with the next crawl_order on a subsequent batch", async () => {
    await crawlBatch(db, fixtureHttp(), config);
    const result = await crawlBatch(db, fixtureHttp(), config);

    expect(result.processedCount).toBe(1);
    expect(result.lastProcessedCrawlOrder).toBe(2);
    const [second] = await db`
      SELECT status FROM categories WHERE crawl_order = 2
    `;
    expect(second.status).toBe("COMPLETED");
  });

  test("records FAILED and stays recoverable when a page cannot be fetched", async () => {
    const failing: HttpClient = {
      async fetchPage() {
        throw new Error("network down");
      },
    };

    const result = await crawlBatch(db, failing, config);
    expect(result.processedCount).toBe(1);
    expect(result.failedCount).toBe(1);

    const [root] = await db`
      SELECT status FROM categories WHERE url = ${ROOT_CATEGORY_URL}
    `;
    expect(root.status).toBe("FAILED");

    const [pending] = await db`
      SELECT COUNT(*)::int AS n FROM categories WHERE status = 'PENDING'
    `;
    expect(pending.n).toBe(0);
  });
});
