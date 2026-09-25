import type { Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { log } from "../logger";
import { AMAZON_IN_ORIGIN } from "../config/env";
import type {
  CategoryRecord,
  CategoryStatus,
  CrawlSummary,
  NewCategory,
  SaveCategoryResult,
} from "./types";

export const ROOT_CATEGORY_URL = `${AMAZON_IN_ORIGIN}/gp/bestsellers/`;
export const ROOT_CATEGORY_NAME = "Amazon Best Sellers";
export const ROOT_CATEGORY_DEPTH = 0;
export const ROOT_CATEGORY_CRAWL_ORDER = 1;

const CRAWL_ORDER_SEQUENCE = "categories_crawl_order_seq";

interface CategoryRow {
  id: bigint | number | string;
  name: string;
  url: string;
  parent_id: bigint | number | string | null;
  depth: number | string;
  crawl_order: bigint | number | string;
  status: string;
  processing_started_at: Date | string | null;
  processed_at: Date | string | null;
  created_at: Date | string;
}

function mapCategory(row: CategoryRow): CategoryRecord {
  return {
    id: Number(row.id),
    name: row.name,
    url: row.url,
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    depth: Number(row.depth),
    crawlOrder: Number(row.crawl_order),
    status: row.status as CategoryStatus,
    processingStartedAt: row.processing_started_at
      ? new Date(String(row.processing_started_at))
      : null,
    processedAt: row.processed_at ? new Date(String(row.processed_at)) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

export interface Initialized {
  root: CategoryRecord;
}

export async function initializeCategories(db: Db): Promise<Initialized> {
  await runMigrations(db);

  await db.begin(async (tx) => {
    await tx`
      UPDATE categories
      SET crawl_order = nextval('categories_crawl_order_seq'::regclass)
      WHERE crawl_order = 1
        AND url <> ${ROOT_CATEGORY_URL}
    `;

    await tx`
      UPDATE categories
      SET crawl_order = 1
      WHERE url = ${ROOT_CATEGORY_URL}
        AND crawl_order <> 1
    `;
  });

  await db`
    INSERT INTO categories (name, url, parent_id, depth, crawl_order, status)
    VALUES (
      ${ROOT_CATEGORY_NAME},
      ${ROOT_CATEGORY_URL},
      NULL,
      ${ROOT_CATEGORY_DEPTH},
      ${ROOT_CATEGORY_CRAWL_ORDER},
      'PENDING'
    )
    ON CONFLICT (url) DO NOTHING
  `;

  const [{ last_value }] = await db`
    SELECT last_value FROM categories_crawl_order_seq
  `;
  const [{ m }] = await db`
    SELECT COALESCE(MAX(crawl_order), 0)::bigint AS m FROM categories
  `;
  await db`
    SELECT setval(
      'categories_crawl_order_seq'::regclass,
      GREATEST(${Number(last_value)}, ${Number(m)}),
      true
    )
  `;

  const [root] = await db`
    SELECT id, name, url, parent_id, depth, crawl_order, status, processing_started_at, processed_at, created_at FROM categories WHERE url = ${ROOT_CATEGORY_URL}
  `;
  if (!root) {
    throw new Error("Root category is missing after initialization");
  }

  log("DATABASE_INITIALIZED", {
    root_id: root.id,
    root_name: root.name,
    root_url: root.url,
  });

  return { root: mapCategory(root as unknown as CategoryRow) };
}

export async function saveCategory(
  db: Db,
  cat: NewCategory
): Promise<SaveCategoryResult> {
  return db.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO categories (name, url, parent_id, depth, crawl_order, status)
      VALUES (
        ${cat.name},
        ${cat.url},
        ${cat.parentId},
        ${cat.depth},
        nextval('categories_crawl_order_seq'::regclass),
        'PENDING'
      )
      ON CONFLICT (url) DO NOTHING
      RETURNING id, name, url, parent_id, depth, crawl_order, status, processing_started_at, processed_at, created_at
    `;

    if (inserted.length > 0) {
      return { record: mapCategory(inserted[0] as unknown as CategoryRow), isNew: true };
    }

    const existing = await tx`
      SELECT id, name, url, parent_id, depth, crawl_order, status, processing_started_at, processed_at, created_at FROM categories WHERE url = ${cat.url}
    `;
    return { record: mapCategory(existing[0] as unknown as CategoryRow), isNew: false };
  });
}

export async function claimNextBatch(
  db: Db,
  batchSize: number,
  staleProcessingTimeoutMs: number
): Promise<CategoryRecord[]> {
  if (batchSize < 1) {
    throw new Error(`batchSize must be >= 1, got ${batchSize}`);
  }

  const staleBefore = new Date(Date.now() - staleProcessingTimeoutMs);

  return db.begin(async (tx) => {
    const rows = await tx`
      WITH pending AS (
        SELECT id, crawl_order FROM categories
        WHERE status = 'PENDING'
        ORDER BY crawl_order
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      stale AS (
        SELECT id, crawl_order FROM categories
        WHERE status = 'PROCESSING'
          AND processing_started_at < ${staleBefore}
        ORDER BY crawl_order
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      candidates AS (
        SELECT id, crawl_order FROM pending
        UNION ALL
        SELECT id, crawl_order FROM stale
      ),
      ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY crawl_order) AS rn
        FROM candidates
      )
      UPDATE categories c
      SET status = 'PROCESSING', processing_started_at = NOW()
      FROM ranked r
      WHERE c.id = r.id AND r.rn <= ${batchSize}
      RETURNING c.id, c.name, c.url, c.parent_id, c.depth, c.crawl_order, c.status, c.processing_started_at, c.processed_at, c.created_at
    `;

    return (rows as unknown as CategoryRow[])
      .sort((a, b) => Number(a.crawl_order) - Number(b.crawl_order))
      .map(mapCategory);
  });
}

export async function completeCategory(db: Db, id: number): Promise<void> {
  await db`
    UPDATE categories
    SET status = 'COMPLETED', processed_at = NOW()
    WHERE id = ${id}
  `;
}

export async function failCategory(db: Db, id: number): Promise<void> {
  await db`
    UPDATE categories
    SET status = 'FAILED', processed_at = NOW()
    WHERE id = ${id}
  `;
}

export async function getCrawlSummary(db: Db): Promise<CrawlSummary> {
  const [row] = await db`
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
      COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing_count,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_count,
      COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_count,
      COALESCE(MAX(crawl_order) FILTER (WHERE status = 'COMPLETED'), 0)::bigint
        AS last_processed_crawl_order
    FROM categories
  `;
  return {
    totalCount: Number(row.total_count),
    pendingCount: Number(row.pending_count),
    processingCount: Number(row.processing_count),
    completedCount: Number(row.completed_count),
    failedCount: Number(row.failed_count),
    remainingPendingCount: Number(row.pending_count),
    lastProcessedCrawlOrder: Number(row.last_processed_crawl_order),
  };
}
