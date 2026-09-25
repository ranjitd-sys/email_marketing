import type { Db } from "../db/client";
import type { HttpClient } from "../http/client";
import type { ProductSellerConfig } from "../config/env";
import { log } from "../logger";
import { buildDiscoveryUrl, parseDiscoveryPage } from "./product-discovery";
import { parseProductPage } from "./product-parser";
import { parseSellerFromProductPage, parseSellerProfile } from "./seller-parser";
import { extractPublicContacts } from "./contact-parser";
import {
  buildBatchSummary,
  claimProductSellerWork,
  markWorkFailure,
  persistWork,
} from "./repository";
import type {
  ParsedContact,
  ParsedProduct,
  ParsedSeller,
  PersistWorkResult,
  ProductSellerBatchSummary,
  WorkTarget,
} from "./types";

interface WorkItem {
  product: ParsedProduct;
  seller: ParsedSeller | null;
  sellerContacts: ParsedContact[];
}

function nowMs(): number {
  return Date.now();
}

function context(target: WorkTarget, workerId: string): Record<string, unknown> {
  return {
    worker_id: workerId,
    category_id: target.categoryId,
    brand_id: target.brandId,
    category_url: target.categoryUrl,
  };
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface SellerProfileCache {
  get(
    key: string,
    loader: () => Promise<ParsedContact[]>
  ): Promise<ParsedContact[]>;
}

export function createSellerProfileCache(): SellerProfileCache {
  const cache = new Map<string, Promise<ParsedContact[]>>();
  return {
    get(key, loader) {
      const existing = cache.get(key);
      if (existing) return existing;
      const promise = loader().catch(() => [] as ParsedContact[]);
      cache.set(key, promise);
      return promise;
    },
  };
}

export interface WorkRunResult {
  persisted: PersistWorkResult;
  entriesSeen: number;
}

export async function runWorkItem(
  db: Db,
  http: HttpClient,
  config: ProductSellerConfig,
  target: WorkTarget,
  sellerProfiles: SellerProfileCache
): Promise<WorkRunResult> {
  const workerId = config.workerId;
  const base = context(target, workerId);

  log("WORK_CLAIMED", { ...base, claim_origin: target.claimOrigin, attempts: target.attempts });
  if (target.claimOrigin === "reclaimed") {
    log("WORK_RECLAIMED", { ...base, attempts: target.attempts });
  }

  const discoveryUrl = buildDiscoveryUrl(target.brandName, target.categoryName);
  log("PRODUCT_PAGE_DISCOVERED", { ...base, discovery_url: discoveryUrl });

  let pageUrl: string | null = discoveryUrl;
  let page = 0;
  let entriesSeen = 0;
  let sellerProfilesFetched = 0;
  const seenAsins = new Set<string>();
  const seenSellerKeys = new Set<string>();
  const items: WorkItem[] = [];

  while (pageUrl !== null && page < config.maxResultPages) {
    page += 1;
    const fetchStartedAt = nowMs();
    const html = await http.fetchPage(pageUrl);
    const fetchLatency = nowMs() - fetchStartedAt;

    const parseStartedAt = nowMs();
    const parsed = parseDiscoveryPage(html);
    const parseLatency = nowMs() - parseStartedAt;

    log("PRODUCT_RESULT_PAGE_PARSED", {
      ...base,
      page,
      products_seen: parsed.products.length,
      request_latency_ms: fetchLatency,
      parse_latency_ms: parseLatency,
      next_page: parsed.nextPageUrl !== null,
    });

    const candidates = parsed.products.filter((entry) => {
      if (seenAsins.has(entry.asin)) return false;
      if (seenAsins.size >= config.maxProductsPerWork) return false;
      seenAsins.add(entry.asin);
      return true;
    });
    entriesSeen += parsed.products.length;

    const results = await mapLimit(candidates, config.maxConcurrency, async (entry) => {
      const productStartedAt = nowMs();
      let productHtml: string;
      try {
        productHtml = await http.fetchPage(entry.url);
      } catch (error) {
        log("PRODUCT_FETCH_FAILED", { ...base, asin: entry.asin, url: entry.url, error: String(error) });
        return null;
      }

      const product = parseProductPage(productHtml, entry.url, entry.asin);
      if (!product) {
        log("PRODUCT_SKIPPED_UNPARSABLE", { ...base, asin: entry.asin, url: entry.url });
        return null;
      }

      log("PRODUCT_DISCOVERED", {
        ...base,
        asin: product.asin,
        url: entry.url,
        title: product.title,
        request_latency_ms: nowMs() - productStartedAt,
      });

      const seller = parseSellerFromProductPage(productHtml);
      const sellerContacts: ParsedContact[] = [];

      if (seller) {
        const key = seller.externalId ?? seller.normalizedName;
        if (seenSellerKeys.has(key)) {
          log("SELLER_DUPLICATE", { ...base, asin: product.asin, seller: seller.name, external_id: seller.externalId });
        } else {
          seenSellerKeys.add(key);
          log("SELLER_DISCOVERED", { ...base, asin: product.asin, seller: seller.name, external_id: seller.externalId });
        }

        if (config.fetchSellerProfiles && sellerProfilesFetched < config.maxSellerProfilesPerWork) {
          sellerProfilesFetched += 1;
          const contacts = await sellerProfiles.get(key, async () => {
            if (!seller.profileUrl) return [];
            const profileHtml = await http.fetchPage(seller.profileUrl!);
            return extractPublicContacts(profileHtml, seller.profileUrl!);
          });
          sellerContacts.push(...contacts);
        }
      }

      const manufacturerContacts = extractPublicContacts(productHtml, entry.url);

      return {
        product,
        seller,
        sellerContacts: [...sellerContacts, ...manufacturerContacts],
      } satisfies WorkItem;
    });

    for (const result of results) {
      if (result) items.push(result);
    }

    if (seenAsins.size >= config.maxProductsPerWork) {
      pageUrl = null;
      break;
    }
    if (parsed.products.length === 0) {
      pageUrl = null;
      break;
    }
    pageUrl = parsed.nextPageUrl;
  }

  if (entriesSeen > 0 && items.length === 0) {
    throw new Error(`All product pages failed for ${target.brandName} in ${target.categoryName}`);
  }

  for (const item of items) {
    log("PRODUCT_SAVED", { ...base, asin: item.product.asin, title: item.product.title });
    for (const contact of item.sellerContacts) {
      if (contact.verificationStatus === "REJECTED") {
        log("CONTACT_SKIPPED", { ...base, value: contact.value, reason: "invalid_format", context: contact.context });
      } else {
        log("CONTACT_DISCOVERED", {
          ...base,
          type: contact.type,
          value: contact.normalizedValue,
          entity_type: contact.entityType,
          context: contact.context,
        });
        log("CONTACT_CLASSIFIED", { ...base, entity_type: contact.entityType, context: contact.context });
      }
    }
  }

  const persisted = await persistWork(db, {
    categoryId: target.categoryId,
    brandId: target.brandId,
    workerId,
    products: items,
  });

  for (let i = 0; i < persisted.sellerProductLinks; i++) {
    log("SELLER_PRODUCT_LINKED", { ...base });
  }
  for (let i = 0; i < persisted.contactsAccepted; i++) {
    log("CONTACT_SAVED", { ...base });
  }

  log("WORK_COMPLETED", {
    ...base,
    products: persisted.uniqueProducts,
    sellers: persisted.uniqueSellers,
    contacts: persisted.contactsAccepted,
  });

  return { persisted, entriesSeen };
}

export async function crawlProductSellerBatch(
  db: Db,
  http: HttpClient,
  config: ProductSellerConfig
): Promise<ProductSellerBatchSummary> {
  const claim = await claimProductSellerWork(db, {
    batchSize: config.batchSize,
    leaseTimeoutMs: config.sellerLeaseTimeoutMs,
    maxAttempts: config.sellerMaxRetries,
    workerId: config.workerId,
  });

  if (claim.exhaustedMarkedFailed > 0) {
    log("WORK_ATTEMPTS_EXHAUSTED", {
      worker_id: config.workerId,
      marked_failed: claim.exhaustedMarkedFailed,
    });
  }

  const sellerProfiles = createSellerProfileCache();
  const aggregate = {
    processedCategoryBrandCount: 0,
    failedCount: 0,
    productsDiscovered: 0,
    uniqueProducts: 0,
    sellersDiscovered: 0,
    uniqueSellers: 0,
    sellerProductRelationships: 0,
    contactsDiscovered: 0,
    contactsAccepted: 0,
    contactsRejected: 0,
  };

  for (const target of claim.claimed) {
    try {
      const { persisted, entriesSeen } = await runWorkItem(db, http, config, target, sellerProfiles);
      aggregate.processedCategoryBrandCount += 1;
      aggregate.productsDiscovered += entriesSeen;
      aggregate.uniqueProducts += persisted.uniqueProducts;
      aggregate.sellersDiscovered += persisted.sellersSeen;
      aggregate.uniqueSellers += persisted.uniqueSellers;
      aggregate.sellerProductRelationships += persisted.sellerProductLinks;
      aggregate.contactsDiscovered += persisted.contactsSeen;
      aggregate.contactsAccepted += persisted.contactsAccepted;
      aggregate.contactsRejected += persisted.contactsRejected;
    } catch (error) {
      aggregate.failedCount += 1;
      const failure = await markWorkFailure(db, {
        categoryId: target.categoryId,
        brandId: target.brandId,
        workerId: config.workerId,
        maxAttempts: config.sellerMaxRetries,
      });
      log("WORK_FAILED", {
        ...context(target, config.workerId),
        error: String(error),
        product_seller_status: failure.status,
        attempts: failure.attempts,
      });
    }
  }

  const summary = await buildBatchSummary(db, {
    ...aggregate,
    reclaimedCount: claim.reclaimed,
  });

  log("PRODUCT_SELLER_BATCH_COMPLETED", {
    worker_id: config.workerId,
    processed_category_brand_count: summary.processedCategoryBrandCount,
    failed_count: summary.failedCount,
    reclaimed_count: summary.reclaimedCount,
    products_discovered: summary.productsDiscovered,
    unique_products: summary.uniqueProducts,
    sellers_discovered: summary.sellersDiscovered,
    unique_sellers: summary.uniqueSellers,
    seller_product_relationships: summary.sellerProductRelationships,
    contacts_discovered: summary.contactsDiscovered,
    contacts_accepted: summary.contactsAccepted,
    contacts_rejected: summary.contactsRejected,
    remaining_pending_work: summary.remainingPendingWork,
    pending_work: summary.pendingWork,
    processing_work: summary.processingWork,
    completed_work: summary.completedWork,
    failed_work: summary.failedWork,
    total_products: summary.totalProducts,
    total_sellers: summary.totalSellers,
    total_contacts: summary.totalContacts,
  });

  return summary;
}
