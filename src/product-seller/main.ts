import { loadProductSellerConfig } from "../config/env";
import { createClient, closeClient } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createHttpClient } from "../http/client";
import { log } from "../logger";
import { crawlProductSellerBatch } from "./crawler";

async function main(): Promise<void> {
  const config = loadProductSellerConfig(process.env);
  const db = createClient(config.databaseUrl);

  log("PRODUCT_SELLER_WORKER_STARTING", {
    worker_id: config.workerId,
    batch_size: config.batchSize,
    max_concurrency: config.maxConcurrency,
    max_result_pages: config.maxResultPages,
    max_products_per_work: config.maxProductsPerWork,
    fetch_seller_profiles: config.fetchSellerProfiles,
  });

  try {
    await runMigrations(db);
    await crawlProductSellerBatch(db, createHttpClient(config), config);
  } finally {
    await closeClient(db);
  }
}

await main().catch((error) => {
  log("PRODUCT_SELLER_CRAWL_FATAL", { error: String(error) });
  process.exitCode = 1;
});
