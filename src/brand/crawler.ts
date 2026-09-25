import type { Db } from "../db/client";
import type { HttpClient } from "../http/client";
import type { BrandConfig } from "../config/env";
import { log } from "../logger";
import {
  buildBrandBatchSummary,
  claimBrandCategories,
  markBrandCategoryFailure,
  persistBrandCrawl,
} from "./repository";
import { dedupeBrandsByNormalizedName, extractBrandResult, parseProductResults } from "./parser";
import { normalizeBrandName } from "./normalizer";
import type { BrandBatchSummary, BrandCrawlTarget, BrandSource } from "./types";

export interface ResolvedBrand {
  brand: string;
  normalizedName: string;
  source: BrandSource;
  asin: string;
}

export interface CategoryBrandCrawlOutcome {
  categoryId: number;
  pagesFetched: number;
  productsSeen: number;
  productsWithBrand: number;
  brands: Array<{ name: string; normalizedName: string }>;
  relationshipsCreated: number;
}

function nowMs(): number {
  return Date.now();
}

function logContext(target: BrandCrawlTarget, workerId: string): Record<string, unknown> {
  return {
    worker_id: workerId,
    category_id: target.categoryId,
    crawl_order: target.crawlOrder,
    category_url: target.categoryUrl,
  };
}

export async function collectBrandsForCategory(
  target: BrandCrawlTarget,
  http: HttpClient,
  config: BrandConfig,
  workerId: string
): Promise<CategoryBrandCrawlOutcome> {
  const startedAt = nowMs();

  const collected: Array<{ brand: string; source: BrandSource }> = [];
  const firstSeenAt = new Map<string, string>();
  let pagesFetched = 0;
  let productsSeen = 0;
  let productsWithBrand = 0;
  const seenAsins = new Set<string>();

  let pageUrl: string | null = target.categoryUrl;
  let page = 0;

  while (pageUrl !== null && page < config.maxCategoryResultPages) {
    page += 1;

    log("BRAND_CATEGORY_FETCH_STARTED", {
      ...logContext(target, workerId),
      page,
    });

    const fetchStartedAt = nowMs();
    let html: string;
    try {
      html = await http.fetchPage(pageUrl);
    } finally {
      log("BRAND_CATEGORY_FETCH_COMPLETED", {
        ...logContext(target, workerId),
        page,
        url: pageUrl,
        fetch_latency_ms: nowMs() - fetchStartedAt,
      });
    }

    pagesFetched += 1;

    const parseStartedAt = nowMs();
    const parsed = parseProductResults(html);
    const parseLatencyMs = nowMs() - parseStartedAt;

    log("BRAND_RESULT_PAGE_PARSED", {
      ...logContext(target, workerId),
      page,
      products_seen: parsed.products.length,
      parse_latency_ms: parseLatencyMs,
      next_page: parsed.nextPageUrl !== null,
    });

    for (const product of parsed.products) {
      if (seenAsins.size >= config.maxProductPagesPerCategory) break;
      if (seenAsins.has(product.asin)) continue;
      seenAsins.add(product.asin);
      productsSeen += 1;

      const productStartedAt = nowMs();
      let productHtml: string;
      try {
        productHtml = await http.fetchPage(product.productUrl);
      } catch (error) {
        log("BRAND_PRODUCT_FETCH_FAILED", {
          ...logContext(target, workerId),
          asin: product.asin,
          product_url: product.productUrl,
          error: String(error),
        });
        continue;
      }

      const outcome = extractBrandResult(productHtml, product.asin);

      if (!outcome.extraction) {
        log("BRAND_SKIPPED_NO_BRAND", {
          ...logContext(target, workerId),
          asin: product.asin,
          product_url: product.productUrl,
          reason: outcome.reason,
          fetch_latency_ms: nowMs() - productStartedAt,
        });
        continue;
      }

      const normalizedName = normalizeBrandName(outcome.extraction.brand);
      if (normalizedName.length === 0) {
        log("BRAND_SKIPPED_NO_BRAND", {
          ...logContext(target, workerId),
          asin: product.asin,
          product_url: product.productUrl,
          reason: "brand_not_plausible",
        });
        continue;
      }

      productsWithBrand += 1;

      if (firstSeenAt.has(normalizedName)) {
        log("BRAND_DUPLICATE", {
          ...logContext(target, workerId),
          asin: product.asin,
          brand: outcome.extraction.brand,
          normalized_name: normalizedName,
          first_seen_asin: firstSeenAt.get(normalizedName),
        });
        continue;
      }

      firstSeenAt.set(normalizedName, product.asin);
      collected.push({ brand: outcome.extraction.brand, source: outcome.extraction.source });

      log("BRAND_DISCOVERED", {
        ...logContext(target, workerId),
        asin: product.asin,
        brand: outcome.extraction.brand,
        normalized_name: normalizedName,
        source: outcome.extraction.source,
      });
    }

    if (seenAsins.size >= config.maxProductPagesPerCategory) {
      pageUrl = null;
      break;
    }

    pageUrl = parsed.nextPageUrl;
  }

  const deduped = dedupeBrandsByNormalizedName(collected);

  log("BRAND_DEDUPE_SUMMARY", {
    ...logContext(target, workerId),
    raw_brand_hits: collected.length,
    unique_brands: deduped.length,
    total_ms: nowMs() - startedAt,
  });

  return {
    categoryId: target.categoryId,
    pagesFetched,
    productsSeen,
    productsWithBrand,
    brands: deduped.map((b) => ({ name: b.brand, normalizedName: b.normalizedName })),
    relationshipsCreated: 0,
  };
}

export async function crawlBrandCategory(
  db: Db,
  http: HttpClient,
  config: BrandConfig,
  target: BrandCrawlTarget
): Promise<CategoryBrandCrawlOutcome> {
  const workerId = config.workerId;

  log("BRAND_CATEGORY_CLAIMED", {
    ...logContext(target, workerId),
    claim_origin: target.claimOrigin,
    brand_attempts: target.brandAttempts,
  });

  if (target.claimOrigin === "reclaimed") {
    log("BRAND_CATEGORY_RECLAIMED", {
      ...logContext(target, workerId),
      brand_attempts: target.brandAttempts,
    });
  }

  const outcome = await collectBrandsForCategory(target, http, config, workerId);

  const persisted = await persistBrandCrawl(db, {
    categoryId: target.categoryId,
    brands: outcome.brands,
    workerId,
  });

  log("BRAND_CATEGORY_COMPLETED", {
    ...logContext(target, workerId),
    pages_fetched: outcome.pagesFetched,
    products_seen: outcome.productsSeen,
    products_with_brand: outcome.productsWithBrand,
    unique_brands: outcome.brands.length,
    relationships_created: persisted.relationshipsCreated,
  });

  return { ...outcome, relationshipsCreated: persisted.relationshipsCreated };
}

export interface BrandBatchResult extends BrandBatchSummary {}

export async function crawlBrandBatch(
  db: Db,
  http: HttpClient,
  config: BrandConfig
): Promise<BrandBatchResult> {
  const claim = await claimBrandCategories(db, {
    batchSize: config.batchSize,
    leaseTimeoutMs: config.brandLeaseTimeoutMs,
    maxAttempts: config.brandMaxRetries,
    workerId: config.workerId,
  });

  if (claim.exhaustedMarkedFailed > 0) {
    log("BRAND_ATTEMPTS_EXHAUSTED", {
      worker_id: config.workerId,
      marked_failed: claim.exhaustedMarkedFailed,
    });
  }

  let processedCategories = 0;
  let failedCategories = 0;
  let uniqueBrandsDiscovered = 0;
  let relationshipsCreated = 0;
  let lastProcessedCrawlOrder = 0;

  for (const target of claim.claimed) {
    try {
      const outcome = await crawlBrandCategory(db, http, config, target);
      processedCategories += 1;
      uniqueBrandsDiscovered += outcome.brands.length;
      relationshipsCreated += outcome.relationshipsCreated;
      lastProcessedCrawlOrder = target.crawlOrder;
    } catch (error) {
      failedCategories += 1;
      lastProcessedCrawlOrder = target.crawlOrder;

      const failure = await markBrandCategoryFailure(db, {
        categoryId: target.categoryId,
        workerId: config.workerId,
        maxAttempts: config.brandMaxRetries,
        error: String(error),
      });

      log("BRAND_CATEGORY_FAILED", {
        ...logContext(target, config.workerId),
        error: String(error),
        brand_status: failure.status,
        brand_attempts: failure.attempts,
      });
    }
  }

  const summary = await buildBrandBatchSummary(db, {
    processedCategories,
    failedCategories,
    reclaimedCategories: claim.reclaimed,
    uniqueBrandsDiscovered,
    relationshipsCreated,
    lastProcessedCrawlOrder,
  });

  log("BRAND_BATCH_COMPLETED", {
    worker_id: config.workerId,
    processed_categories: summary.processedCategories,
    failed_categories: summary.failedCategories,
    reclaimed_categories: summary.reclaimedCategories,
    unique_brands_discovered: summary.uniqueBrandsDiscovered,
    relationships_created: summary.relationshipsCreated,
    last_processed_crawl_order: summary.lastProcessedCrawlOrder,
    remaining_pending_categories: summary.remainingPendingCategories,
    brand_categories_pending: summary.brandCategoriesPending,
    brand_categories_processing: summary.brandCategoriesProcessing,
    brand_categories_completed: summary.brandCategoriesCompleted,
    brand_categories_failed: summary.brandCategoriesFailed,
    brands_discovered_total: summary.brandsDiscoveredTotal,
    category_brand_relationships_total: summary.categoryBrandRelationshipsTotal,
  });

  return summary;
}
