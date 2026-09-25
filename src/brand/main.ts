import { loadBrandConfig } from "../config/env";
import { createClient, closeClient } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createHttpClient } from "../http/client";
import { log } from "../logger";
import { crawlBrandBatch } from "./crawler";

async function main(): Promise<void> {
  const config = loadBrandConfig(process.env);
  const db = createClient(config.databaseUrl);

  log("BRAND_WORKER_STARTING", {
    worker_id: config.workerId,
    batch_size: config.batchSize,
    max_category_result_pages: config.maxCategoryResultPages,
    max_product_pages_per_category: config.maxProductPagesPerCategory,
  });

  try {
    await runMigrations(db);
    await crawlBrandBatch(db, createHttpClient(config), config);
  } finally {
    await closeClient(db);
  }
}

await main().catch((error) => {
  log("BRAND_CRAWL_FATAL", { error: String(error) });
  process.exitCode = 1;
});
