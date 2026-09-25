import type { Db } from "../db/client";
import type { HttpClient } from "../http/client";
import type { CrawlConfig } from "../config/env";
import { log } from "../logger";
import {
  claimNextBatch,
  completeCategory,
  failCategory,
  getCrawlSummary,
  initializeCategories,
  saveCategory,
} from "./repository";
import type { CategoryRecord, ParsedCategory } from "./types";
import { parseCategoryPage } from "./parser";
import { isCategoryUrl, normalizeCategoryUrl } from "./normalizer";

export interface CrawlBatchResult {
  processedCount: number;
  discoveredCount: number;
  failedCount: number;
  remainingPendingCount: number;
  lastProcessedCrawlOrder: number;
}

export async function crawlBatch(
  db: Db,
  http: HttpClient,
  config: CrawlConfig
): Promise<CrawlBatchResult> {
  const batch = await claimNextBatch(
    db,
    config.batchSize,
    config.staleProcessingTimeoutMs
  );

  let processedCount = 0;
  let discoveredCount = 0;
  let failedCount = 0;

  for (const row of batch) {
    processedCount++;
    log("CATEGORY_PROCESSING_STARTED", {
      id: row.id,
      crawl_order: row.crawlOrder,
      depth: row.depth,
      url: row.url,
    });

    try {
      const html = await http.fetchPage(row.url);
      const parsed = parseCategoryPage(html, row.url);

      for (const child of parsed.categories) {
        if (!isCategoryUrl(child.url)) continue;

        let url: string;
        try {
          url = normalizeCategoryUrl(child.url);
        } catch {
          log("CATEGORY_CHILD_REJECTED_INVALID_URL", {
            parent_id: row.id,
            child_name: child.name,
            child_url: child.url,
          });
          continue;
        }

        if (url === row.url) continue;

        const result = await saveCategory(db, {
          name: child.name,
          url,
          parentId: row.id,
          depth: row.depth + 1,
        });

        if (result.isNew) {
          discoveredCount++;
          log("CATEGORY_DISCOVERED", {
            id: result.record.id,
            name: result.record.name,
            url: result.record.url,
            parent_id: result.record.parentId,
            depth: result.record.depth,
            crawl_order: result.record.crawlOrder,
          });
        } else {
          log("CATEGORY_SKIPPED_DUPLICATE", {
            id: result.record.id,
            name: result.record.name,
            url: result.record.url,
          });
        }
      }

      await completeCategory(db, row.id);
      log("CATEGORY_PROCESSING_COMPLETED", {
        id: row.id,
        crawl_order: row.crawlOrder,
        children_found: parsed.categories.length,
      });
    } catch (error) {
      failedCount++;
      await failCategory(db, row.id);
      log("CATEGORY_PROCESSING_FAILED", {
        id: row.id,
        crawl_order: row.crawlOrder,
        url: row.url,
        error: String(error),
      });
    }
  }

  const summary = await getCrawlSummary(db);
  const lastRow = batch.at(-1);
  const lastProcessedCrawlOrder = lastRow ? lastRow.crawlOrder : 0;

  log("CATEGORY_BATCH_COMPLETED", {
    processed_count: processedCount,
    discovered_count: discoveredCount,
    failed_count: failedCount,
    remaining_pending_count: summary.remainingPendingCount,
    last_processed_crawl_order: lastProcessedCrawlOrder,
  });

  return {
    processedCount,
    discoveredCount,
    failedCount,
    remainingPendingCount: summary.remainingPendingCount,
    lastProcessedCrawlOrder,
  };
}

export async function runCategoryCrawler(
  db: Db,
  http: HttpClient,
  config: CrawlConfig
): Promise<CrawlBatchResult> {
  await initializeCategories(db);
  return crawlBatch(db, http, config);
}
