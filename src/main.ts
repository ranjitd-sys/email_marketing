import { loadConfig } from "./config/env";
import { createClient, closeClient } from "./db/client";
import { initializeCategories } from "./category/repository";
import { crawlBatch } from "./category/crawler";
import { createHttpClient } from "./http/client";
import { log } from "./logger";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createClient(config.databaseUrl);

  try {
    await initializeCategories(db);
    const result = await crawlBatch(db, createHttpClient(config), config);
    log("CATEGORY_BATCH_COMPLETED", {
      processed_count: result.processedCount,
      discovered_count: result.discoveredCount,
      failed_count: result.failedCount,
      remaining_pending_count: result.remainingPendingCount,
      last_processed_crawl_order: result.lastProcessedCrawlOrder,
    });
  } finally {
    await closeClient(db);
  }
}

await main().catch((error) => {
  log("CATEGORY_CRAWL_FATAL", { error: String(error) });
  process.exitCode = 1;
});
