import { AMAZON_IN_ORIGIN } from "../config/env";
import type { Db } from "../db/client";
import type {
  ParsedContact,
  ParsedProduct,
  ParsedSeller,
  PersistWorkInput,
  PersistWorkResult,
  ProductSellerBatchSummary,
  WorkClaimResult,
  WorkStateCounts,
  WorkStatus,
  WorkTarget,
} from "./types";

interface WorkRow {
  category_id: bigint | number | string;
  brand_id: bigint | number | string;
  category_name: string;
  category_url: string;
  brand_name: string;
  brand_normalized_name: string;
  product_seller_attempts: number | string;
  claim_origin: string;
}

function mapWorkTarget(row: WorkRow): WorkTarget {
  return {
    categoryId: Number(row.category_id),
    categoryName: row.category_name,
    categoryUrl: row.category_url,
    brandId: Number(row.brand_id),
    brandName: row.brand_name,
    brandNormalizedName: row.brand_normalized_name,
    attempts: Number(row.product_seller_attempts),
    claimOrigin: row.claim_origin === "reclaimed" ? "reclaimed" : "pending",
  };
}

export interface ClaimWorkOptions {
  batchSize: number;
  leaseTimeoutMs: number;
  maxAttempts: number;
  workerId: string;
}

export async function claimProductSellerWork(
  db: Db,
  options: ClaimWorkOptions
): Promise<WorkClaimResult> {
  const { batchSize, leaseTimeoutMs, maxAttempts, workerId } = options;
  if (batchSize < 1) {
    throw new Error(`batchSize must be >= 1, got ${batchSize}`);
  }
  const leaseExpiredBefore = new Date(Date.now() - leaseTimeoutMs);

  return db.begin(async (tx) => {
    const exhausted = await tx`
      UPDATE category_brands
      SET product_seller_status = 'FAILED',
          product_seller_locked_by = NULL,
          product_seller_locked_at = NULL
      WHERE product_seller_status IN ('PENDING', 'PROCESSING')
        AND product_seller_attempts >= ${maxAttempts}
      RETURNING category_id
    `;

    const rows = await tx`
      WITH pending AS (
        SELECT cb.category_id, cb.brand_id, 'pending'::text AS origin
        FROM category_brands cb
        WHERE cb.product_seller_status = 'PENDING'
          AND cb.product_seller_attempts < ${maxAttempts}
        ORDER BY cb.category_id, cb.brand_id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      stale AS (
        SELECT cb.category_id, cb.brand_id, 'reclaimed'::text AS origin
        FROM category_brands cb
        WHERE cb.product_seller_status = 'PROCESSING'
          AND cb.product_seller_attempts < ${maxAttempts}
          AND (cb.product_seller_locked_at IS NULL OR cb.product_seller_locked_at < ${leaseExpiredBefore})
        ORDER BY cb.category_id, cb.brand_id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      picked AS (
        SELECT category_id, brand_id, origin,
               ROW_NUMBER() OVER (ORDER BY category_id, brand_id) AS rn
        FROM (
          SELECT category_id, brand_id, origin FROM pending
          UNION ALL
          SELECT category_id, brand_id, origin FROM stale
        ) AS u
      )
      UPDATE category_brands cb
      SET product_seller_status = 'PROCESSING',
          product_seller_locked_by = ${workerId},
          product_seller_locked_at = NOW(),
          product_seller_processing_started_at = NOW(),
          product_seller_attempts = cb.product_seller_attempts + 1
      FROM picked p, categories c, brands b
      WHERE cb.category_id = p.category_id
        AND cb.brand_id = p.brand_id
        AND c.id = cb.category_id
        AND b.id = cb.brand_id
        AND p.rn <= ${batchSize}
      RETURNING cb.category_id, cb.brand_id, p.origin AS claim_origin,
                cb.product_seller_attempts, c.name AS category_name, c.url AS category_url,
                b.name AS brand_name, b.normalized_name AS brand_normalized_name
    `;

    const claimed = (rows as unknown as WorkRow[])
      .map(mapWorkTarget)
      .sort((a, b) => a.categoryId - b.categoryId || a.brandId - b.brandId);

    return {
      claimed,
      reclaimed: claimed.filter((t) => t.claimOrigin === "reclaimed").length,
      exhaustedMarkedFailed: exhausted.length,
    };
  });
}

export interface UpsertProductInput {
  product: ParsedProduct;
  brandId: number;
}

export interface UpsertIdResult {
  id: number;
  inserted: boolean;
}

export async function upsertProduct(
  db: Db,
  input: UpsertProductInput
): Promise<UpsertIdResult> {
  const p = input.product;
  const rows = await db`
    INSERT INTO products (
      asin, title, brand_id, url, price, mrp, discount, rating, review_count,
      availability, description, manufacturer, model_number
    )
    VALUES (
      ${p.asin}, ${p.title}, ${input.brandId}, ${`${AMAZON_IN_ORIGIN}/dp/${p.asin}/`},
      ${p.price}, ${p.mrp}, ${p.discount}, ${p.rating}, ${p.reviewCount},
      ${p.availability}, ${p.description}, ${p.manufacturer}, ${p.modelNumber}
    )
    ON CONFLICT (asin) DO UPDATE SET
      title = COALESCE(EXCLUDED.title, products.title),
      brand_id = COALESCE(EXCLUDED.brand_id, products.brand_id),
      url = COALESCE(EXCLUDED.url, products.url),
      price = COALESCE(EXCLUDED.price, products.price),
      mrp = COALESCE(EXCLUDED.mrp, products.mrp),
      discount = COALESCE(EXCLUDED.discount, products.discount),
      rating = COALESCE(EXCLUDED.rating, products.rating),
      review_count = COALESCE(EXCLUDED.review_count, products.review_count),
      availability = COALESCE(EXCLUDED.availability, products.availability),
      description = COALESCE(EXCLUDED.description, products.description),
      manufacturer = COALESCE(EXCLUDED.manufacturer, products.manufacturer),
      model_number = COALESCE(EXCLUDED.model_number, products.model_number),
      last_seen_at = NOW(),
      updated_at = NOW()
    RETURNING id, (xmax = 0) AS inserted
  `;
  return { id: Number(rows[0].id), inserted: Boolean(rows[0].inserted) };
}

export async function linkCategoryProduct(
  db: Db,
  categoryId: number,
  productId: number
): Promise<UpsertIdResult> {
  const rows = await db`
    INSERT INTO category_products (category_id, product_id)
    VALUES (${categoryId}, ${productId})
    ON CONFLICT (category_id, product_id) DO UPDATE SET last_seen_at = NOW()
    RETURNING (xmax = 0) AS inserted
  `;
  return { id: productId, inserted: Boolean(rows[0].inserted) };
}

export async function linkBrandProduct(
  db: Db,
  brandId: number,
  productId: number
): Promise<UpsertIdResult> {
  const rows = await db`
    INSERT INTO brand_products (brand_id, product_id)
    VALUES (${brandId}, ${productId})
    ON CONFLICT (brand_id, product_id) DO UPDATE SET last_seen_at = NOW()
    RETURNING (xmax = 0) AS inserted
  `;
  return { id: productId, inserted: Boolean(rows[0].inserted) };
}

export async function upsertSeller(
  db: Db,
  seller: ParsedSeller
): Promise<UpsertIdResult> {
  if (seller.externalId) {
    const rows = await db`
      INSERT INTO sellers (external_id, name, normalized_name, public_profile_url)
      VALUES (${seller.externalId}, ${seller.name}, ${seller.normalizedName}, ${seller.profileUrl})
      ON CONFLICT (external_id) WHERE external_id IS NOT NULL
      DO UPDATE SET
        name = EXCLUDED.name,
        normalized_name = EXCLUDED.normalized_name,
        public_profile_url = COALESCE(EXCLUDED.public_profile_url, sellers.public_profile_url),
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS inserted
    `;
    return { id: Number(rows[0].id), inserted: Boolean(rows[0].inserted) };
  }

  const rows = await db`
    INSERT INTO sellers (external_id, name, normalized_name, public_profile_url)
    VALUES (NULL, ${seller.name}, ${seller.normalizedName}, ${seller.profileUrl})
    ON CONFLICT (normalized_name) WHERE external_id IS NULL
    DO UPDATE SET
      name = EXCLUDED.name,
      public_profile_url = COALESCE(EXCLUDED.public_profile_url, sellers.public_profile_url),
      last_seen_at = NOW(),
      updated_at = NOW()
    RETURNING id, (xmax = 0) AS inserted
  `;
  return { id: Number(rows[0].id), inserted: Boolean(rows[0].inserted) };
}

export async function linkSellerProduct(
  db: Db,
  sellerId: number,
  productId: number
): Promise<UpsertIdResult> {
  const rows = await db`
    INSERT INTO seller_products (seller_id, product_id)
    VALUES (${sellerId}, ${productId})
    ON CONFLICT (seller_id, product_id) DO UPDATE SET last_seen_at = NOW()
    RETURNING (xmax = 0) AS inserted
  `;
  return { id: productId, inserted: Boolean(rows[0].inserted) };
}

export interface UpsertContactInput {
  contact: ParsedContact;
  sellerId: number | null;
  entityId: number | null;
}

export async function upsertContact(
  db: Db,
  input: UpsertContactInput
): Promise<{ id: number; inserted: boolean }> {
  const c = input.contact;
  const insertedRows = await db`
    INSERT INTO contacts (
      seller_id, contact_type, contact_value, normalized_value,
      entity_type, entity_id, source, source_url, context, verification_status
    )
    VALUES (
      ${input.sellerId}, ${c.type}, ${c.value}, ${c.normalizedValue},
      ${c.entityType}, ${input.entityId}, ${c.source}, ${c.sourceUrl},
      ${c.context}, ${c.verificationStatus}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;

  if (insertedRows.length > 0) {
    return { id: Number(insertedRows[0].id), inserted: true };
  }

  const updated = await db`
    UPDATE contacts
    SET last_seen_at = NOW()
    WHERE contact_type = ${c.type}
      AND normalized_value = ${c.normalizedValue}
      AND source = ${c.source}
      AND COALESCE(context, '') = ${c.context}
      AND COALESCE(entity_id, 0) = ${input.entityId ?? 0}
    RETURNING id
  `;

  return { id: updated.length > 0 ? Number(updated[0].id) : 0, inserted: false };
}

export async function persistWork(
  db: Db,
  input: PersistWorkInput
): Promise<PersistWorkResult> {
  return db.begin(async (tx) => {
    const result: PersistWorkResult = {
      productsSeen: input.products.length,
      uniqueProducts: 0,
      productsInserted: 0,
      categoryProductLinks: 0,
      brandProductLinks: 0,
      sellersSeen: 0,
      uniqueSellers: 0,
      sellerProductLinks: 0,
      contactsSeen: 0,
      contactsAccepted: 0,
      contactsRejected: 0,
      contactsUnattributed: 0,
    };

    const seenProducts = new Set<string>();
    const seenSellers = new Set<string>();

    for (const item of input.products) {
      const saved = await upsertProduct(tx as unknown as Db, {
        product: item.product,
        brandId: input.brandId,
      });
      if (!seenProducts.has(item.product.asin)) {
        seenProducts.add(item.product.asin);
        result.uniqueProducts += 1;
      }
      if (saved.inserted) result.productsInserted += 1;

      const categoryLink = await linkCategoryProduct(
        tx as unknown as Db,
        input.categoryId,
        saved.id
      );
      if (categoryLink.inserted) result.categoryProductLinks += 1;

      const brandLink = await linkBrandProduct(tx as unknown as Db, input.brandId, saved.id);
      if (brandLink.inserted) result.brandProductLinks += 1;

      if (item.seller) {
        result.sellersSeen += 1;
        const seller = await upsertSeller(tx as unknown as Db, item.seller);
        if (!seenSellers.has(item.seller.normalizedName + "|" + (item.seller.externalId ?? ""))) {
          seenSellers.add(item.seller.normalizedName + "|" + (item.seller.externalId ?? ""));
          result.uniqueSellers += 1;
        }

        const link = await linkSellerProduct(tx as unknown as Db, seller.id, saved.id);
        if (link.inserted) result.sellerProductLinks += 1;

        for (const contact of item.sellerContacts) {
          result.contactsSeen += 1;
          if (contact.verificationStatus === "REJECTED") {
            result.contactsRejected += 1;
            continue;
          }
          const entityId = contact.entityType === "SELLER" ? seller.id : null;
          const saved2 = await upsertContact(tx as unknown as Db, {
            contact,
            sellerId: contact.entityType === "SELLER" ? seller.id : null,
            entityId,
          });
          if (saved2.inserted) result.contactsAccepted += 1;
          if (contact.entityType === "UNKNOWN") result.contactsUnattributed += 1;
        }
      }
    }

    const completed = await tx`
      UPDATE category_brands
      SET product_seller_status = 'COMPLETED',
          product_seller_processed_at = NOW(),
          product_seller_locked_by = NULL,
          product_seller_locked_at = NULL
      WHERE category_id = ${input.categoryId}
        AND brand_id = ${input.brandId}
        AND product_seller_status = 'PROCESSING'
        AND product_seller_locked_by = ${input.workerId}
      RETURNING category_id
    `;
    if (completed.length === 0) {
      throw new Error(
        `Refusing to complete work ${input.categoryId}/${input.brandId}: lease no longer held by ${input.workerId}`
      );
    }

    return result;
  });
}

export interface MarkFailureInput {
  categoryId: number;
  brandId: number;
  workerId: string;
  maxAttempts: number;
}

export async function markWorkFailure(
  db: Db,
  input: MarkFailureInput
): Promise<{ status: WorkStatus; attempts: number }> {
  return db.begin(async (tx) => {
    const rows = await tx`
      UPDATE category_brands
      SET product_seller_status = CASE
            WHEN product_seller_attempts >= ${input.maxAttempts} THEN 'FAILED'
            ELSE 'PENDING'
          END,
          product_seller_locked_by = NULL,
          product_seller_locked_at = NULL
      WHERE category_id = ${input.categoryId}
        AND brand_id = ${input.brandId}
        AND product_seller_status = 'PROCESSING'
        AND product_seller_locked_by = ${input.workerId}
      RETURNING product_seller_status, product_seller_attempts
    `;
    if (rows.length === 0) {
      const [current] = await tx`
        SELECT product_seller_status, product_seller_attempts
        FROM category_brands
        WHERE category_id = ${input.categoryId} AND brand_id = ${input.brandId}
      `;
      return {
        status: (current?.product_seller_status ?? "FAILED") as WorkStatus,
        attempts: Number(current?.product_seller_attempts ?? 0),
      };
    }
    return {
      status: rows[0].product_seller_status as WorkStatus,
      attempts: Number(rows[0].product_seller_attempts),
    };
  });
}

export async function getWorkStateCounts(db: Db): Promise<WorkStateCounts> {
  const [row] = await db`
    SELECT
      COUNT(*)::int AS total_work,
      COUNT(*) FILTER (WHERE product_seller_status = 'PENDING')::int AS pending_work,
      COUNT(*) FILTER (WHERE product_seller_status = 'PROCESSING')::int AS processing_work,
      COUNT(*) FILTER (WHERE product_seller_status = 'COMPLETED')::int AS completed_work,
      COUNT(*) FILTER (WHERE product_seller_status = 'FAILED')::int AS failed_work
    FROM category_brands
  `;
  return {
    totalWork: Number(row.total_work),
    pendingWork: Number(row.pending_work),
    processingWork: Number(row.processing_work),
    completedWork: Number(row.completed_work),
    failedWork: Number(row.failed_work),
  };
}

export async function getTotals(
  db: Db
): Promise<{ totalProducts: number; totalSellers: number; totalContacts: number }> {
  const [row] = await db`
    SELECT
      (SELECT COUNT(*)::int FROM products) AS total_products,
      (SELECT COUNT(*)::int FROM sellers) AS total_sellers,
      (SELECT COUNT(*)::int FROM contacts) AS total_contacts
  `;
  return {
    totalProducts: Number(row.total_products),
    totalSellers: Number(row.total_sellers),
    totalContacts: Number(row.total_contacts),
  };
}

export interface BatchSummaryInput {
  processedCategoryBrandCount: number;
  failedCount: number;
  reclaimedCount: number;
  productsDiscovered: number;
  uniqueProducts: number;
  sellersDiscovered: number;
  uniqueSellers: number;
  sellerProductRelationships: number;
  contactsDiscovered: number;
  contactsAccepted: number;
  contactsRejected: number;
}

export async function buildBatchSummary(
  db: Db,
  input: BatchSummaryInput
): Promise<ProductSellerBatchSummary> {
  const [counts, totals] = await Promise.all([getWorkStateCounts(db), getTotals(db)]);
  return {
    processedCategoryBrandCount: input.processedCategoryBrandCount,
    failedCount: input.failedCount,
    reclaimedCount: input.reclaimedCount,
    productsDiscovered: input.productsDiscovered,
    uniqueProducts: input.uniqueProducts,
    sellersDiscovered: input.sellersDiscovered,
    uniqueSellers: input.uniqueSellers,
    sellerProductRelationships: input.sellerProductRelationships,
    contactsDiscovered: input.contactsDiscovered,
    contactsAccepted: input.contactsAccepted,
    contactsRejected: input.contactsRejected,
    remainingPendingWork: counts.pendingWork,
    pendingWork: counts.pendingWork,
    processingWork: counts.processingWork,
    completedWork: counts.completedWork,
    failedWork: counts.failedWork,
    totalProducts: totals.totalProducts,
    totalSellers: totals.totalSellers,
    totalContacts: totals.totalContacts,
  };
}

export async function resetFailedWork(db: Db): Promise<number> {
  const rows = await db`
    UPDATE category_brands
    SET product_seller_status = 'PENDING',
        product_seller_attempts = 0,
        product_seller_locked_by = NULL,
        product_seller_locked_at = NULL
    WHERE product_seller_status = 'FAILED'
    RETURNING category_id
  `;
  return rows.length;
}
