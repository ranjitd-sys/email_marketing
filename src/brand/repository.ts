import type { Db } from "../db/client";
import type {
  BrandBatchSummary,
  BrandCrawlStateCounts,
  BrandCrawlTarget,
  BrandRecord,
  BrandStatus,
  ClaimOrigin,
  NewBrandInput,
} from "./types";

interface BrandRow {
  id: bigint | number | string;
  name: string;
  normalized_name: string;
  created_at: Date | string;
  updated_at: Date | string;
  inserted?: boolean | number;
}

interface TargetRow {
  id: bigint | number | string;
  name: string;
  url: string;
  depth: number | string;
  crawl_order: bigint | number | string;
  brand_status: string;
  brand_attempts: number | string;
  claim_origin: string;
}

function mapBrand(row: BrandRow): BrandRecord {
  return {
    id: Number(row.id),
    name: row.name,
    normalizedName: row.normalized_name,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function mapTarget(row: TargetRow): BrandCrawlTarget {
  return {
    categoryId: Number(row.id),
    categoryName: row.name,
    categoryUrl: row.url,
    depth: Number(row.depth),
    crawlOrder: Number(row.crawl_order),
    brandStatus: row.brand_status as BrandStatus,
    brandAttempts: Number(row.brand_attempts),
    claimOrigin: row.claim_origin as ClaimOrigin,
  };
}

export interface ClaimOptions {
  batchSize: number;
  leaseTimeoutMs: number;
  maxAttempts: number;
  workerId: string;
}

export interface ClaimResult {
  claimed: BrandCrawlTarget[];
  reclaimed: number;
  exhaustedMarkedFailed: number;
}

export async function claimBrandCategories(
  db: Db,
  options: ClaimOptions
): Promise<ClaimResult> {
  const { batchSize, leaseTimeoutMs, maxAttempts, workerId } = options;
  if (batchSize < 1) {
    throw new Error(`batchSize must be >= 1, got ${batchSize}`);
  }

  const leaseExpiredBefore = new Date(Date.now() - leaseTimeoutMs);

  return db.begin(async (tx) => {
    const exhausted = await tx`
      UPDATE categories
      SET brand_status = 'FAILED',
          brand_locked_by = NULL,
          brand_locked_at = NULL
      WHERE brand_status IN ('PENDING', 'PROCESSING')
        AND brand_attempts >= ${maxAttempts}
      RETURNING id
    `;

    const rows = await tx`
      WITH pending AS (
        SELECT id, crawl_order, 'pending'::text AS origin
        FROM categories
        WHERE brand_status = 'PENDING'
          AND brand_attempts < ${maxAttempts}
        ORDER BY crawl_order
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      stale AS (
        SELECT id, crawl_order, 'reclaimed'::text AS origin
        FROM categories
        WHERE brand_status = 'PROCESSING'
          AND brand_attempts < ${maxAttempts}
          AND (brand_locked_at IS NULL OR brand_locked_at < ${leaseExpiredBefore})
        ORDER BY crawl_order
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      candidates AS (
        SELECT id, crawl_order, origin FROM pending
        UNION ALL
        SELECT id, crawl_order, origin FROM stale
      ),
      ranked AS (
        SELECT id, crawl_order, origin,
               ROW_NUMBER() OVER (ORDER BY crawl_order) AS rn
        FROM candidates
      )
      UPDATE categories c
      SET brand_status = 'PROCESSING',
          brand_locked_by = ${workerId},
          brand_locked_at = NOW(),
          brand_processing_started_at = NOW(),
          brand_attempts = c.brand_attempts + 1
      FROM ranked r
      WHERE c.id = r.id AND r.rn <= ${batchSize}
      RETURNING c.id, c.name, c.url, c.depth, c.crawl_order,
                c.brand_status, c.brand_attempts, r.origin AS claim_origin
    `;

    const claimed = (rows as unknown as TargetRow[])
      .map(mapTarget)
      .sort((a, b) => a.crawlOrder - b.crawlOrder);

    return {
      claimed,
      reclaimed: claimed.filter((t) => t.claimOrigin === "reclaimed").length,
      exhaustedMarkedFailed: exhausted.length,
    };
  });
}

export interface UpsertBrandOutcome {
  brand: BrandRecord;
  isNew: boolean;
}

export async function upsertBrand(
  db: Db,
  input: NewBrandInput
): Promise<UpsertBrandOutcome> {
  const rows = await db`
    INSERT INTO brands (name, normalized_name)
    VALUES (${input.name}, ${input.normalizedName})
    ON CONFLICT (normalized_name)
    DO UPDATE SET updated_at = NOW()
    RETURNING id, name, normalized_name, created_at, updated_at, (xmax = 0) AS inserted
  `;

  const row = rows[0] as unknown as BrandRow;
  return {
    brand: mapBrand(row),
    isNew: Boolean(row.inserted),
  };
}

export interface PersistBrandCrawlInput {
  categoryId: number;
  brands: Array<{ name: string; normalizedName: string }>;
  workerId: string;
}

export interface PersistBrandCrawlResult {
  brandIds: number[];
  relationshipsCreated: number;
}

export async function persistBrandCrawl(
  db: Db,
  input: PersistBrandCrawlInput
): Promise<PersistBrandCrawlResult> {
  const { categoryId, brands, workerId } = input;

  return db.begin(async (tx) => {
    const brandIds: number[] = [];
    let relationshipsCreated = 0;

    for (const brand of brands) {
      const rows = await tx`
        INSERT INTO brands (name, normalized_name)
        VALUES (${brand.name}, ${brand.normalizedName})
        ON CONFLICT (normalized_name)
        DO UPDATE SET updated_at = NOW()
        RETURNING id
      `;
      const brandId = Number(rows[0].id);
      brandIds.push(brandId);

      const [{ inserted }] = await tx`
        WITH ins AS (
          INSERT INTO category_brands (category_id, brand_id)
          VALUES (${categoryId}, ${brandId})
          ON CONFLICT (category_id, brand_id) DO NOTHING
          RETURNING 1
        )
        SELECT COUNT(*)::int AS inserted FROM ins
      `;
      if (inserted > 0) relationshipsCreated += 1;
    }

    const completed = await tx`
      UPDATE categories
      SET brand_status = 'COMPLETED',
          brand_processed_at = NOW(),
          brand_locked_by = NULL,
          brand_locked_at = NULL
      WHERE id = ${categoryId}
        AND brand_status = 'PROCESSING'
        AND brand_locked_by = ${workerId}
      RETURNING id
    `;

    if (completed.length === 0) {
      throw new Error(
        `Refusing to complete category ${categoryId}: lease is no longer held by ${workerId}`
      );
    }

    return { brandIds, relationshipsCreated };
  });
}

export interface MarkFailureInput {
  categoryId: number;
  workerId: string;
  maxAttempts: number;
  error: string;
}

export interface MarkFailureResult {
  status: BrandStatus;
  attempts: number;
}

export async function markBrandCategoryFailure(
  db: Db,
  input: MarkFailureInput
): Promise<MarkFailureResult> {
  const { categoryId, workerId, maxAttempts } = input;

  return db.begin(async (tx) => {
    const rows = await tx`
      UPDATE categories
      SET brand_status = CASE
            WHEN brand_attempts >= ${maxAttempts} THEN 'FAILED'
            ELSE 'PENDING'
          END,
          brand_locked_by = NULL,
          brand_locked_at = NULL
      WHERE id = ${categoryId}
        AND brand_status = 'PROCESSING'
        AND brand_locked_by = ${workerId}
      RETURNING brand_status, brand_attempts
    `;

    if (rows.length === 0) {
      const [current] = await tx`
        SELECT brand_status, brand_attempts FROM categories WHERE id = ${categoryId}
      `;
      return {
        status: (current?.brand_status ?? "FAILED") as BrandStatus,
        attempts: Number(current?.brand_attempts ?? 0),
      };
    }

    return {
      status: rows[0].brand_status as BrandStatus,
      attempts: Number(rows[0].brand_attempts),
    };
  });
}

export async function getBrandCrawlStateCounts(db: Db): Promise<BrandCrawlStateCounts> {
  const [row] = await db`
    SELECT
      COUNT(*)::int AS total_categories,
      COUNT(*) FILTER (WHERE brand_status = 'PENDING')::int AS pending_categories,
      COUNT(*) FILTER (WHERE brand_status = 'PROCESSING')::int AS processing_categories,
      COUNT(*) FILTER (WHERE brand_status = 'COMPLETED')::int AS completed_categories,
      COUNT(*) FILTER (WHERE brand_status = 'FAILED')::int AS failed_categories
    FROM categories
  `;

  return {
    totalCategories: Number(row.total_categories),
    pendingCategories: Number(row.pending_categories),
    processingCategories: Number(row.processing_categories),
    completedCategories: Number(row.completed_categories),
    failedCategories: Number(row.failed_categories),
  };
}

export async function getBrandTotals(
  db: Db
): Promise<{ brandsDiscoveredTotal: number; categoryBrandRelationshipsTotal: number }> {
  const [row] = await db`
    SELECT
      (SELECT COUNT(*)::int FROM brands) AS brands_discovered_total,
      (SELECT COUNT(*)::int FROM category_brands) AS category_brand_relationships_total
  `;

  return {
    brandsDiscoveredTotal: Number(row.brands_discovered_total),
    categoryBrandRelationshipsTotal: Number(row.category_brand_relationships_total),
  };
}

export interface BrandSummaryInput {
  processedCategories: number;
  failedCategories: number;
  reclaimedCategories: number;
  uniqueBrandsDiscovered: number;
  relationshipsCreated: number;
  lastProcessedCrawlOrder: number;
}

export async function buildBrandBatchSummary(
  db: Db,
  input: BrandSummaryInput
): Promise<BrandBatchSummary> {
  const [counts, totals] = await Promise.all([
    getBrandCrawlStateCounts(db),
    getBrandTotals(db),
  ]);

  return {
    processedCategories: input.processedCategories,
    failedCategories: input.failedCategories,
    reclaimedCategories: input.reclaimedCategories,
    uniqueBrandsDiscovered: input.uniqueBrandsDiscovered,
    relationshipsCreated: input.relationshipsCreated,
    lastProcessedCrawlOrder: input.lastProcessedCrawlOrder,
    remainingPendingCategories: counts.pendingCategories,
    brandCategoriesPending: counts.pendingCategories,
    brandCategoriesProcessing: counts.processingCategories,
    brandCategoriesCompleted: counts.completedCategories,
    brandCategoriesFailed: counts.failedCategories,
    brandsDiscoveredTotal: totals.brandsDiscoveredTotal,
    categoryBrandRelationshipsTotal: totals.categoryBrandRelationshipsTotal,
  };
}

export async function resetFailedBrandCategories(db: Db): Promise<number> {
  const rows = await db`
    UPDATE categories
    SET brand_status = 'PENDING',
        brand_attempts = 0,
        brand_locked_by = NULL,
        brand_locked_at = NULL
    WHERE brand_status = 'FAILED'
    RETURNING id
  `;
  return rows.length;
}
